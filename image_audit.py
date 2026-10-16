# -*- coding: utf-8 -*-
"""
图片分类审核脚本
================
使用本地部署的 VLM 模型(qwen3-6-35b-a3b)审核图片是否匹配其所在目录的分类标签。

支持三种审核模式：
  mini  : 每个叶子目录抽 5 张（快速验证）
  spot  : 每个叶子目录抽 30~50 张（抽查评估错误率）
  full  : 全量审核

用法：
  python image_audit.py --mode mini
  python image_audit.py --mode spot --sample-size 30
  python image_audit.py --mode full
  python image_audit.py --mode mini --dirs 涉政/执法机关   # 只审核特定目录
"""

import os
import sys
import json
import time
import base64
import random
import argparse
import re
import io
import traceback
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
from PIL import Image
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# 导入标签描述体系
from label_descriptions import SYSTEM_PROMPT, build_prompt

# ============================================================
# 配置
# ============================================================

# 模型 API
API_ENDPOINT = os.getenv("PLANNER_MODEL_ENDPOINT", "http://58.251.255.50:8229/v1")
MODEL_NAME = os.getenv("PLANNER_MODEL_NAME", "qwen3-6-35b-a3b")

# 数据源目录
SOURCE_DIRS = [
    r"F:\Sdznsh0410\源文件\1.6万张",
    r"F:\Sdznsh0410\源文件\涉政5000",
]

# 输出目录
OUTPUT_DIR = r"F:\Sdznsh0410\审核报告"

# 图片预处理
IMAGE_MAX_DIM = 1024
IMAGE_QUALITY = 85

# 模型调用
MAX_TOKENS = 1500
TEMPERATURE = 0.1
API_TIMEOUT = 180
MAX_RETRIES = 2
RETRY_DELAY = 5

# 并发
MAX_WORKERS = 4

# 图片扩展名
IMG_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'}

# 中间结果文件（支持断点续跑）
CHECKPOINT_FILE = os.path.join(OUTPUT_DIR, "checkpoint.json")


# ============================================================
# 图片预处理
# ============================================================

def compress_image(image_path: str) -> str:
    """读取图片，压缩到 IMAGE_MAX_DIM 以内，返回 base64 编码"""
    img = Image.open(image_path)
    # 处理 RGBA 等模式
    if img.mode != 'RGB':
        img = img.convert('RGB')
    # 按比例缩放
    if max(img.size) > IMAGE_MAX_DIM:
        ratio = IMAGE_MAX_DIM / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    # 编码
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=IMAGE_QUALITY)
    return base64.b64encode(buf.getvalue()).decode()


# ============================================================
# 模型调用
# ============================================================

def call_model(image_b64: str, prompt: str) -> dict:
    """调用 VLM 模型，返回解析后的 JSON 结果"""
    url = f"{API_ENDPOINT}/chat/completions"
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                {"type": "text", "text": f"/no_think\n{prompt}"},
            ]},
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
    }

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(url, json=payload, timeout=API_TIMEOUT)
            if resp.status_code != 200:
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY)
                    continue
                return _error_result(f"API错误: {last_error}")

            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return parse_model_output(content)

        except Exception as e:
            last_error = str(e)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY)
            else:
                return _error_result(f"调用异常: {last_error}")

    return _error_result(f"重试耗尽: {last_error}")


def _extract_json(content: str) -> dict | None:
    """从文本中提取 JSON 对象，支持嵌套大括号"""
    # 找到最后一个 { 开始的位置
    for start in range(len(content)):
        if content[start] == '{':
            # 尝试从这个位置开始匹配嵌套大括号
            depth = 0
            for i in range(start, len(content)):
                if content[i] == '{':
                    depth += 1
                elif content[i] == '}':
                    depth -= 1
                    if depth == 0:
                        chunk = content[start:i + 1]
                        try:
                            return json.loads(chunk)
                        except Exception:
                            break  # 这个 { 匹配不上，试下一个
    return None


def _clean_reason_text(text: str) -> str:
    """清理模型输出文本中的 markdown 标记和噪声"""
    # 去掉所有 markdown 加粗/斜体标记 **xxx** *xxx* -> xxx
    text = re.sub(r'\*{1,2}(.+?)\*{1,2}', r'\1', text)
    # 去掉残留的单个 *
    text = text.replace('*', '')
    # 去掉 markdown 列表标记 - • 
    text = re.sub(r'^[\s]*[\-\•]\s*', '', text, flags=re.MULTILINE)
    # 去掉开头的"结论："、"判断："等引导词
    text = re.sub(r'^(结论|判断|答案|结果)[：:]\s*', '', text)
    # 去掉多余空白
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _extract_conclusion(content: str, is_match: bool) -> str:
    """从模型输出的推理文本中提取核心结论句子"""
    # 按句号、换行分句
    sentences = re.split(r'[。\n！？]', content)
    # 清理每句
    sentences = [_clean_reason_text(s) for s in sentences]
    # 过滤太短、无意义的、推理碎片
    skip_prefixes = ["如果", "假设", "让我们", "首先", "接下来", "那么它", "但是", "因此",
                     "所以还是", "至于", "理由", "Actual content", "reason", "match"]
    sentences = [s for s in sentences if len(s) > 8 and not any(s.lower().startswith(p.lower()) for p in skip_prefixes)]

    if not sentences:
        # 完全无法提取，返回通用判定
        return "图片内容与标签匹配" if is_match else "图片内容与标签不匹配"

    # 优先找包含明确判定的句子（排除假设性语句）
    if is_match:
        keywords = ["符合", "属于", "匹配", "确认为", "完全符合"]
    else:
        keywords = ["并非", "不是", "不属于", "不符合", "不匹配", "错误", "误标", "应为", "非中国", "外国"]

    # 从后往前找（结论通常在末尾）
    candidates = []
    for s in reversed(sentences):
        if any(kw in s for kw in keywords):
            candidates.append(s)
            if len(candidates) >= 2:
                break

    if candidates:
        # 取最长的候选（通常信息最全）
        return max(candidates, key=len)[:80]

    # fallback: 取最后一句
    return sentences[-1][:80]


def parse_model_output(content: str) -> dict:
    """从模型输出中提取 JSON 结果"""
    # 处理 thinking 模式
    if "</think>" in content:
        content = content.split("</think>")[-1].strip()

    # 移除 markdown 代码块标记
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        if lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines).strip()

    # 方式1: 直接解析
    try:
        result = json.loads(content)
        return _normalize_result(result)
    except json.JSONDecodeError:
        pass

    # 方式2: 提取最后一个完整 JSON 对象（支持嵌套）
    result = _extract_json(content)
    if result:
        return _normalize_result(result)

    # 方式3: 模型只输出了一半 JSON（被 max_tokens 截断）
    # 尝试补全：找到 "match": true/false 就推断结果
    match_val = re.search(r'"match"\s*:\s*(true|false)', content)
    if match_val:
        reason_match = re.search(r'"reason"\s*:\s*"([^"]*)"', content)
        return _normalize_result({
            "match": match_val.group(1) == "true",
            "confidence": 0.6,
            "reason": reason_match.group(1) if reason_match else "（截断补全）",
            "actual_content": "",
            "suggested_label": "",
        })

    # 方式4: 文本语义分析（模型输出了推理文字但没输出JSON）
    # 分析最后几句的语义倾向
    last_200 = content[-200:] if len(content) > 200 else content
    mismatch_keywords = ["并非", "不是", "不属于", "不符合", "不匹配", "无法确认", "错误", "误标",
                         "非中国", "外国", "并非中国", "不属于该", "与标签不符", "应为"]
    match_keywords = ["符合", "属于", "匹配", "确认为", "完全符合", "符合标签", "符合定义"]
    mismatch_score = sum(1 for kw in mismatch_keywords if kw in last_200)
    match_score = sum(1 for kw in match_keywords if kw in last_200)
    if mismatch_score > 0 or match_score > 0:
        is_match = match_score > mismatch_score
        # 清理文本，提取核心结论
        clean = _extract_conclusion(content, is_match)
        return _normalize_result({
            "match": is_match,
            "confidence": 0.55,
            "reason": f"（语义推断）{clean}",
            "actual_content": "",
            "suggested_label": "",
        })

    return _error_result(f"JSON解析失败，原始输出: {content[:200]}")


def _normalize_result(result: dict) -> dict:
    """规范化模型输出字段"""
    # 处理 match 为字符串 "true"/"false" 的情况
    raw_match = result.get("match", False)
    if isinstance(raw_match, str):
        match_val = raw_match.lower().strip() == "true"
    else:
        match_val = bool(raw_match)

    return {
        "match": match_val,
        "confidence": float(result.get("confidence", 0.5)),
        "reason": _clean_reason_text(str(result.get("reason", ""))),
        "actual_content": str(result.get("actual_content", "")),
        "suggested_label": str(result.get("suggested_label", "")),
        "raw_error": None,
    }


def _error_result(msg: str) -> dict:
    return {
        "match": None,
        "confidence": 0.0,
        "reason": msg,
        "actual_content": "",
        "suggested_label": "",
        "raw_error": msg,
    }


# ============================================================
# 目录扫描与采样
# ============================================================

def scan_directories():
    """扫描所有数据源，返回 [(dataset, leaf_dir, label_path, image_list), ...]"""
    results = []
    for source_dir in SOURCE_DIRS:
        if not os.path.exists(source_dir):
            print(f"[警告] 数据源目录不存在: {source_dir}")
            continue
        dataset_name = os.path.basename(source_dir)

        for root, dirs, files in os.walk(source_dir):
            imgs = sorted([f for f in files if os.path.splitext(f)[1].lower() in IMG_EXTS])
            if not imgs:
                continue
            # 计算标签路径（相对数据源目录）
            rel_path = os.path.relpath(root, source_dir)
            label_parts = rel_path.split(os.sep)
            label_path = " > ".join(label_parts)
            full_imgs = [os.path.join(root, f) for f in imgs]
            results.append({
                "dataset": dataset_name,
                "leaf_dir": root,
                "label_path": label_path,
                "images": full_imgs,
            })
    return results


def sample_images(dir_info: dict, mode: str, sample_size: int = 30) -> list:
    """根据模式采样图片"""
    all_imgs = dir_info["images"]
    if mode == "full":
        return all_imgs
    elif mode == "mini":
        n = min(5, len(all_imgs))
        return random.sample(all_imgs, n)
    elif mode == "spot":
        n = min(sample_size, len(all_imgs))
        return random.sample(all_imgs, n)
    else:
        raise ValueError(f"未知模式: {mode}")


# ============================================================
# 断点续跑
# ============================================================

checkpoint_lock = Lock()


def load_checkpoint() -> dict:
    """加载已完成的审核结果"""
    if os.path.exists(CHECKPOINT_FILE):
        try:
            with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_checkpoint(checkpoint: dict):
    """保存审核结果"""
    with checkpoint_lock:
        os.makedirs(os.path.dirname(CHECKPOINT_FILE), exist_ok=True)
        with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
            json.dump(checkpoint, f, ensure_ascii=False, indent=2)


# ============================================================
# 审核单张图片
# ============================================================

def audit_single_image(image_path: str, label_path: str) -> dict:
    """审核单张图片，返回完整结果"""
    # 压缩图片
    try:
        img_b64 = compress_image(image_path)
    except Exception as e:
        return _error_result(f"图片读取失败: {e}")

    # 构建 prompt
    prompt = build_prompt(label_path)

    # 调用模型
    result = call_model(img_b64, prompt)
    result["image_path"] = image_path
    result["label_path"] = label_path
    return result


# ============================================================
# Excel 报告生成
# ============================================================

def generate_excel_report(results: list, output_path: str):
    """生成 Excel 报告"""
    wb = Workbook()

    # --- Sheet 1: 汇总 ---
    ws1 = wb.active
    ws1.title = "汇总"

    # 按目录统计
    dir_stats = {}
    for r in results:
        key = r.get("label_path", "未知标签")
        if key not in dir_stats:
            dir_stats[key] = {"total": 0, "match": 0, "mismatch": 0, "error": 0}
        dir_stats[key]["total"] += 1
        if r.get("raw_error"):
            dir_stats[key]["error"] += 1
        elif r.get("match") is True:
            dir_stats[key]["match"] += 1
        elif r.get("match") is False:
            dir_stats[key]["mismatch"] += 1

    # 样式
    header_font = Font(name="微软雅黑", bold=True, size=11, color="FFFFFF")
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    mismatch_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
    error_fill = PatternFill(start_color="FFEB9C", end_color="FFEB9C", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin"),
    )

    # 表头
    headers1 = ["标签路径", "审核数量", "匹配数", "不匹配数", "错误数", "匹配率", "不匹配率"]
    for col, h in enumerate(headers1, 1):
        cell = ws1.cell(row=1, column=col, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    # 数据行
    row_idx = 2
    for label_path, stats in sorted(dir_stats.items()):
        total = stats["total"]
        match_rate = f"{stats['match']/total*100:.1f}%" if total > 0 else "0%"
        mismatch_rate = f"{stats['mismatch']/total*100:.1f}%" if total > 0 else "0%"
        row_data = [label_path, total, stats["match"], stats["mismatch"], stats["error"], match_rate, mismatch_rate]
        for col, val in enumerate(row_data, 1):
            cell = ws1.cell(row=row_idx, column=col, value=val)
            cell.border = thin_border
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            # 高亮
            if stats["mismatch"] > 0 and col == 4:
                cell.fill = mismatch_fill
            if stats["error"] > 0 and col == 5:
                cell.fill = error_fill
        row_idx += 1

    # 列宽
    ws1.column_dimensions["A"].width = 60
    for col in range(2, 8):
        ws1.column_dimensions[get_column_letter(col)].width = 12

    # --- Sheet 2: 明细（按一级分类分组） ---
    ws2 = wb.create_sheet("明细")
    headers2 = ["图片路径", "标签路径", "是否匹配", "置信度", "实际内容", "判断理由", "建议标签", "错误信息"]
    for col, h in enumerate(headers2, 1):
        cell = ws2.cell(row=1, column=col, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    # 只输出不匹配和错误的，跳过匹配的
    filtered = [r for r in results if r.get("match") is not True or r.get("raw_error")]

    # 按一级分类（label_path 第一个段）分组
    from collections import OrderedDict
    groups = OrderedDict()
    for r in filtered:
        lp = r.get("label_path", "其它")
        top_cat = lp.split(" > ")[0].strip() if " > " in lp else lp
        if top_cat not in groups:
            groups[top_cat] = []
        groups[top_cat].append(r)

    # 分类标题行样式
    cat_font = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
    cat_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")

    row_idx = 2
    for cat, cat_results in groups.items():
        # 分类标题行
        mismatch_n = sum(1 for r in cat_results if r["match"] is False)
        error_n = sum(1 for r in cat_results if r.get("raw_error"))
        cat_title = f"【{cat}】共 {len(cat_results)} 张（不匹配 {mismatch_n}，错误 {error_n}）"
        ws2.merge_cells(start_row=row_idx, start_column=1, end_row=row_idx, end_column=8)
        cell = ws2.cell(row=row_idx, column=1, value=cat_title)
        cell.font = cat_font
        cell.fill = cat_fill
        cell.alignment = Alignment(horizontal="left", vertical="center")
        cell.border = thin_border
        row_idx += 1

        # 该分类下的明细，按 label_path 排序
        cat_results.sort(key=lambda x: x.get("label_path", ""))
        for r in cat_results:
            match_str = ""
            if r["match"] is True:
                match_str = "匹配"
            elif r["match"] is False:
                match_str = "不匹配"
            else:
                match_str = "错误"

            # 图片路径改为从"源文件"开始的相对路径
            img_path = r["image_path"]
            marker = "源文件"
            if marker in img_path:
                idx = img_path.index(marker)
                display_path = img_path[idx:]
            else:
                display_path = img_path

            row_data = [
                display_path,
                r["label_path"],
                match_str,
                f"{r['confidence']:.2f}",
                r.get("actual_content", ""),
                r.get("reason", ""),
                r.get("suggested_label", ""),
                r.get("raw_error") or "",
            ]
            for col, val in enumerate(row_data, 1):
                cell = ws2.cell(row=row_idx, column=col, value=val)
                cell.border = thin_border
                cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
                if r["match"] is False:
                    cell.fill = mismatch_fill
                elif r.get("raw_error"):
                    cell.fill = error_fill
            row_idx += 1

        # 分类之间空一行
        row_idx += 1

    # 列宽
    ws2.column_dimensions["A"].width = 50
    ws2.column_dimensions["B"].width = 50
    ws2.column_dimensions["C"].width = 8
    ws2.column_dimensions["D"].width = 8
    ws2.column_dimensions["E"].width = 30
    ws2.column_dimensions["F"].width = 40
    ws2.column_dimensions["G"].width = 30
    ws2.column_dimensions["H"].width = 30

    # 冻结首行
    ws1.freeze_panes = "A2"
    ws2.freeze_panes = "A2"

    wb.save(output_path)


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="图片分类审核脚本")
    parser.add_argument("--mode", choices=["mini", "spot", "full"], default="mini",
                        help="审核模式: mini=每目录5张, spot=每目录30~50张, full=全量")
    parser.add_argument("--sample-size", type=int, default=30,
                        help="spot模式每目录抽样数量 (默认30)")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS,
                        help=f"并发线程数 (默认{MAX_WORKERS})")
    parser.add_argument("--dirs", type=str, default=None,
                        help="只审核包含此关键词的目录(如 '武警' 或 '执法机关')")
    parser.add_argument("--resume", action="store_true",
                        help="从断点继续（跳过已审核的图片）")
    parser.add_argument("--retry-errors", action="store_true",
                        help="只重跑 checkpoint 中失败的图片")
    args = parser.parse_args()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 加载断点（retry-errors 和 resume 都需要）
    checkpoint = load_checkpoint() if (args.resume or args.retry_errors) else {}

    if args.retry_errors:
        # 只跑 checkpoint 中失败的图片
        print("=" * 70)
        print(f"重试模式: 只重跑失败图片")
        print(f"并发线程: {args.workers}")
        print(f"模型: {MODEL_NAME} @ {API_ENDPOINT}")
        print("=" * 70)

        pending_tasks = []
        for img_path, result in checkpoint.items():
            if result.get("raw_error"):
                pending_tasks.append({
                    "image_path": img_path,
                    "label_path": result.get("label_path", ""),
                })

        total_tasks = len(pending_tasks)
        skipped = len(checkpoint) - total_tasks
        print(f"checkpoint 总计: {len(checkpoint)}, 失败: {total_tasks}, 跳过: {skipped}")

        if total_tasks == 0:
            print("没有失败的图片需要重试，退出。")
            return

        tasks = pending_tasks
        all_dirs = []
    else:
        # 正常流程：扫描目录 + 采样
        print("=" * 70)
        print(f"审核模式: {args.mode}")
        if args.mode == "spot":
            print(f"每目录抽样: {args.sample_size} 张")
        print(f"并发线程: {args.workers}")
        print(f"模型: {MODEL_NAME} @ {API_ENDPOINT}")
        print("=" * 70)

        all_dirs = scan_directories()
        if args.dirs:
            keyword = args.dirs
            all_dirs = [d for d in all_dirs if keyword in d["label_path"]]
            print(f"目录过滤: '{keyword}' -> 匹配 {len(all_dirs)} 个目录")

        # 采样
        tasks = []
        for d in all_dirs:
            sampled = sample_images(d, args.mode, args.sample_size)
            for img_path in sampled:
                tasks.append({
                    "image_path": img_path,
                    "label_path": d["label_path"],
                })

        total_tasks = len(tasks)
        total_dirs = len(all_dirs)
        print(f"目录数: {total_dirs}")
        print(f"待审核图片: {total_tasks} 张")

        if total_tasks == 0:
            print("没有图片需要审核，退出。")
            return

        # 过滤已完成
        pending_tasks = []
        skipped = 0
        for t in tasks:
            key = t["image_path"]
            if key in checkpoint and checkpoint[key].get("raw_error") is None:
                skipped += 1
            else:
                pending_tasks.append(t)

        if skipped > 0:
            print(f"断点续跑: 跳过 {skipped} 张已完成图片")

    # 执行审核
    results = []
    completed = skipped
    start_time = time.time()

    print(f"\n开始审核... (共 {len(pending_tasks)} 张待处理)")

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_task = {}
        for t in pending_tasks:
            future = executor.submit(audit_single_image, t["image_path"], t["label_path"])
            future_to_task[future] = t

        for future in as_completed(future_to_task):
            task = future_to_task[future]
            try:
                result = future.result()
            except Exception as e:
                result = _error_result(f"线程异常: {e}")
                result["image_path"] = task["image_path"]
                result["label_path"] = task["label_path"]

            results.append(result)

            # 更新断点
            checkpoint[task["image_path"]] = result
            completed += 1

            # 进度输出
            elapsed = time.time() - start_time
            speed = (completed - skipped) / elapsed if elapsed > 0 else 0
            eta = (len(pending_tasks) - (completed - skipped)) / speed if speed > 0 else 0

            status = "✓" if result["match"] else ("✗" if result["match"] is False else "!")
            reason_short = result.get("reason", "")[:40]

            if completed % 10 == 0 or completed == total_tasks:
                print(f"  [{completed}/{total_tasks}] {speed:.1f}张/s ETA:{eta:.0f}s | {status} {os.path.basename(task['image_path'])} - {reason_short}")

            # 定期保存断点
            if completed % 20 == 0:
                save_checkpoint(checkpoint)

    # 最终保存断点
    save_checkpoint(checkpoint)

    # 最终结果：统一从 checkpoint 取，避免重复
    results = [checkpoint[t["image_path"]] for t in tasks if t["image_path"] in checkpoint]

    # 生成报告
    elapsed_total = time.time() - start_time
    mismatch_count = sum(1 for r in results if r["match"] is False)
    error_count = sum(1 for r in results if r.get("raw_error"))

    print("\n" + "=" * 70)
    print(f"审核完成!")
    print(f"  总图片: {len(results)}")
    print(f"  匹配:   {len(results) - mismatch_count - error_count}")
    print(f"  不匹配: {mismatch_count}")
    print(f"  错误:   {error_count}")
    print(f"  耗时:   {elapsed_total:.0f}s")

    # 输出 Excel
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    mode_suffix = f"{args.mode}" + (f"_{args.sample_size}" if args.mode == "spot" else "")
    excel_path = os.path.join(OUTPUT_DIR, f"审核报告_{mode_suffix}_{timestamp}.xlsx")
    generate_excel_report(results, excel_path)
    print(f"  报告:   {excel_path}")
    print("=" * 70)


if __name__ == "__main__":
    main()
