/* -*- coding: utf-8 -*-
 * 通用数据解析标注平台 前端逻辑
 * 三区结构：总览 / 图片（标注+复核+AI助手）/ 文本（目录+标注池+AI助手）
 */
"use strict";

// ==================== 全局状态 ====================
const S = {
  tree: null,
  probe: null,
  view: "dashboard",
  // 昵称身份（协作 P2）：localStorage 持久化，同一昵称 = 同一身份
  user: localStorage.getItem("label_user") || "",
  // 项目（协作底座）
  projects: [], projectId: "",
  // 图片
  imgMode: "label",               // label / review
  // 复核台（图片复核模式）
  rvQueue: [], rvIdx: -1, rvFilters: { status: "pending", result: "all", q: "" },
  // 标注模式
  curDir: "", gridOffset: 0, gridTotal: 0, gridItems: [],
  editor: null, editQueue: [], editQueueIdx: -1,
  // 文本
  txtMode: "src",                 // src / pool
  txtTree: null, txtDir: "",
  // 文本标注池
  tl: { filter: "all", q: "", vlmTimer: null, labels: [] },
  // 批量预标注轮询
  batchTimer: null,
};

const EN_LABELS = [
  "traffic_police_emblem","luxury_brand","traffic","TV_logo","chariot",
  "endangered_species","scientist","bikini","thigh_close_up","designer_bag",
  "submachine_gun","national_flag","taiwan_independence_flag","blood_spatter",
  "traffic&police","map","armed&police","comic","Navy","knife","other","Army",
  "aircraft&carrier","sniper&rifle","rifle","explosives","special&uniform",
  "Separatist&forces&of&terrorist&organizations","masked&armed","armed&personnel",
  "pistol","gambling","missile","ISIS","smoking","Party&flag","national&emblem",
  "Party&emblem","SWAT","military&flag","Air&Force",
  "Counterfeit&and&shoddy&products&as&well&as&fraudulent&theft","drug-related",
  "Invisible&watermark","Platform&watermark&occlusion","Party&member&badge",
  "Illegal&transactions","QQ&WeChat&promotion","National&Institution&Badge",
  "Violation&flag","military&emblem","Special&Administrative&Region&Flag",
  "Revolutionary&martyrs&and&national&heroes","Cult&organizations&and&separatist&forces",
  "Falun&Gong&flag","Brand-related&prohibited&words","Forging&the&logo&of&a&TV&station",
  "tattoo","extreme&remarks","The&flag&of&a&criminal&gang","The&banner&of&Almighty&God",
];

// ==================== 工具函数 ====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

async function api(path, opts = {}) {
  // 未设置昵称时禁止写操作：先弹窗引导设置，取消则中止请求（仅可浏览，协作 P2）
  if (opts.method === "POST" && !S.user && !await ensureUser(true)) {
    return { error: "请先设置昵称后再操作" };
  }
  // 注入昵称身份头（协作 P2）；HTTP 头仅允许 ASCII，中文昵称需 percent-encode
  opts.headers = Object.assign({ "X-User": encodeURIComponent(S.user || "") }, opts.headers || {});
  if (opts.method === "POST" && opts.body && typeof opts.body === "object") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  return r.json();
}

// ==================== 昵称身份（协作 P2） ====================
function renderUserBadge() {
  $("#user-badge").textContent = S.user ? `👤 ${S.user}` : "👤 未设置";
}

// 弹出昵称输入框（始终可取消，取消后仍可浏览图片）。
// 返回 Promise<name|null>，null 表示用户取消。
function promptNickname() {
  return new Promise((resolve) => {
    const modal = $("#user-modal"), inp = $("#inp-user-name");
    inp.value = S.user || "";
    modal.style.display = "flex";
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = (name) => {
      modal.style.display = "none";
      $("#user-ok").onclick = null;
      $("#user-cancel").onclick = null;
      inp.onkeydown = null;
      resolve(name);
    };
    const submit = () => {
      const name = inp.value.trim().slice(0, 32);
      if (!name) { toast("请输入昵称", false); return; }
      done(name);
    };
    $("#user-ok").onclick = submit;
    $("#user-cancel").onclick = () => done(null);
    inp.onkeydown = (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") done(null);
    };
  });
}

// 确保已有昵称：无昵称或 forceOpen=true 时弹窗；取消返回 false
async function ensureUser(forceOpen = false) {
  if (S.user && !forceOpen) return true;
  const name = await promptNickname();
  if (!name) return false;
  S.user = name;
  localStorage.setItem("label_user", name);
  renderUserBadge();
  return true;
}

$("#user-badge").onclick = async () => {
  const prev = S.user;
  if (!await ensureUser(true)) return;
  if (S.user === prev) return;
  await api("/api/session");    // 带新昵称触发成员注册 / 活跃刷新
  toast(`昵称已更新：${S.user}`);
};

function toast(msg, ok = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = ok ? "#0f172a" : "#dc2626";
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function imgUrl(rel, thumb = false) {
  return `/api/image?path=${encodeURIComponent(rel)}${thumb ? "&thumb=1" : ""}`;
}

function fmtSize(n) {
  return n >= 10000 ? (n / 10000).toFixed(1) + "万" : String(n);
}

// ==================== 路由 ====================
$$(".tab").forEach(btn => btn.addEventListener("click", () => nav(btn.dataset.view)));

function nav(view) {
  S.view = view;
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  if (view === "dashboard") loadDashboard();
  if (view === "image") initImageLine();
  if (view === "text") initTextLine();
}

// ==================== 探测报告渲染（总览 / 导入弹窗共用） ====================
const JSON_KIND_CN = {
  vlm_checkpoint: "VLM 预标注结果",
  box_annotation: "框标注（dataList）",
  ann_results: "汇总标注（导入时转为框标注）",
  unknown_ann: "未识别格式的汇总标注",
  unknown_dict: "未知 JSON（对象）",
  unknown_list: "未知 JSON（列表）",
  empty: "空文件",
  unreadable: "不可读",
};

// 未知标注格式：AI 兜底识别（切片→VLM→适配器/脚本→预览→确认导入）
async function aiParseFormat(rel, btn) {
  btn.disabled = true;
  btn.textContent = "识别中…";
  const r = await api("/api/format/ai_parse", { method: "POST", body: { path: rel } });
  btn.disabled = false;
  btn.textContent = "🤖 AI 识别";
  if (r.error) { btn.textContent = "🤖 重试识别"; return toast(r.error, false); }
  const lines = (r.preview || []).map(p => `  ${p.file}：${p.boxes} 框`).join("\n");
  if (!confirm(`识别方式：${r.source}\n条目数：${r.entries}\n预览（前 ${r.preview.length} 张）：\n${lines}\n标签：${(r.labels || []).join("、") || "无"}\n\n确认解析导入全部标注？`)) return;
  const r2 = await api("/api/format/apply", { method: "POST", body: { path: rel } });
  if (r2.error) return toast(r2.error, false);
  toast(`已导入 ${r2.written} 个镜像（${r2.skipped} 个已存在跳过），标签：${(r2.labels || []).join("、")}`);
  setTimeout(() => location.reload(), 900);
}

function renderProbeReport(probe, opts = {}) {
  if (!probe) return `<p class="muted">无解析结果</p>`;
  const imgs = probe.images || {}, txts = probe.texts || {};
  const roles = probe.roles || {};
  const rows = [];

  const catsRaw = imgs.top_cats || [];
  const cats = Array.isArray(catsRaw)
    ? catsRaw.filter(c => Array.isArray(c) && c.length >= 2)
    : Object.entries(catsRaw);
  const dirNote = cats.length
    ? `${cats.length >= 20 ? "20+" : cats.length} 个分类目录`   // server 端 top_cats 截前 20
    : "根目录平铺，无子目录分类";
  rows.push(`<div class="probe-row"><div class="probe-k">图片</div>
    <div class="probe-v">共 <b>${fmtSize(imgs.count || 0)}</b> 张 · ${dirNote}</div></div>`);

  if (txts.count) {
    rows.push(`<div class="probe-row"><div class="probe-k">文本</div>
      <div class="probe-v">共 <b>${fmtSize(txts.count)}</b> 行 txt，分布在 <b>${txts.dirs || 0}</b> 个目录</div></div>`);
  } else {
    rows.push(`<div class="probe-row"><div class="probe-k">文本</div><div class="probe-v muted">未发现 txt 文件</div></div>`);
  }

  const jsons = probe.jsons || [];
  if (jsons.length) {
    const jHtml = jsons.slice(0, 12).map(j => {
      const kind = JSON_KIND_CN[j.kind] || j.kind;
      const extra = (j.count !== undefined && j.kind !== "empty" && j.kind !== "unreadable") ? ` <b>${j.count}</b>条` : "";
      return `<span class="probe-chip">🧾 ${esc(j.rel || "?")} · ${kind}${extra}</span>`;
    }).join("");
    rows.push(`<div class="probe-row"><div class="probe-k">JSON 标注</div>
      <div class="probe-v">发现 ${jsons.length} 个<div class="probe-chips">${jHtml}</div></div></div>`);
  } else {
    rows.push(`<div class="probe-row"><div class="probe-k">JSON 标注</div>
      <div class="probe-v" style="color:var(--amber)">未发现 json 标注文件</div></div>`);
  }

  const roleHtml = [];
  if (roles.checkpoint) roleHtml.push(`<span class="probe-chip ok">✔ VLM 预标注结果：${esc(roles.checkpoint)}</span>`);
  if (roles.json_root) roleHtml.push(`<span class="probe-chip ok">✔ 检测到与图片同名的框标注 json</span>`);
  (roles.results_jsons || []).forEach(rj =>
    roleHtml.push(`<span class="probe-chip ok">✔ 汇总标注：${esc(rj)}（导入时框会加载到图片上）</span>`));
  (roles.unknown_anns || []).forEach(rj =>
    roleHtml.push(`<span class="probe-chip warn">❓ 未知标注格式：${esc(rj)}
      <button class="mini-btn" onclick="aiParseFormat('${esc(rj)}', this)">🤖 AI 识别</button></span>`));
  if (!roles.checkpoint && !roles.json_root && !(roles.results_jsons || []).length && !(roles.unknown_anns || []).length) {
    roleHtml.push(`<span class="probe-chip warn">未发现标注文件 · 可让 AI 自动预标注</span>`);
  }
  if (!opts.skipRoles) {
    rows.push(`<div class="probe-row"><div class="probe-k">角色推导</div><div class="probe-v"><div class="probe-chips">${roleHtml.join("")}</div></div></div>`);
  }

  return rows.join("");
}

// ==================== Dashboard ====================
// 入口卡进度文案：能做什么 + 当前进展，点击直达对应功能
function renderDashActions(st) {
  const txts = (S.probe && S.probe.texts) || {};
  $("#da-anno-progress").textContent = `已标注 ${fmtSize(st.box_annotated || 0)} / ${fmtSize(st.image_total)} 张`;
  $("#da-vlm-desc").textContent = st.vlm.total
    ? `已预标注 ${fmtSize(st.vlm.total)} 张 · 可继续或修正`
    : "VLM 自动打标签，人工只需修正";
  $("#da-review-desc").textContent = st.review.reviewed
    ? `已复核 ${fmtSize(st.review.reviewed)} 张 · 可继续`
    : "核对 AI 与人工标注结果";
  const txtCard = $("#da-text");
  if (txts.count) {
    txtCard.style.display = "";
    $("#da-text-desc").textContent = `${fmtSize(txts.count)} 行待标注`;
  } else {
    txtCard.style.display = "none";
  }
}

async function loadDashboard() {
  // 未上传数据：显示默认引导页（隐藏右上角上传按钮，避免与中间按钮重复）
  if (!S.probe) {
    $("#dash-empty").style.display = "";
    $("#dash-content").style.display = "none";
    $("#btn-data").style.display = "none";
    return;
  }
  $("#dash-empty").style.display = "none";
  $("#dash-content").style.display = "";
  $("#btn-data").style.display = "";
  // 先刷新解析报告（总览略去角色推导，减少信息量）
  const pr = await api("/api/probe");
  if (pr.probe) S.probe = pr.probe;
  $("#probe-report").innerHTML = renderProbeReport(S.probe, { skipRoles: true });
  const proj = (S.projects || []).find(p => p.id === S.projectId);
  $("#dash-src-name").textContent = proj ? `项目：${proj.name}` : "";

  const st = await api("/api/stats");
  if (st.error) {
    toast(`统计数据加载失败：${st.error}`, false);
    return;
  }
  renderDashActions(st);
  const rv = st.review;
  $("#dash-cards").innerHTML = `
    <div class="card"><div class="num">${fmtSize(st.image_total)}</div><div class="name">图片总数</div></div>
    <div class="card"><div class="num">${st.dir_count}</div><div class="name">分类目录数</div></div>
    <div class="card"><div class="num">${fmtSize(st.vlm.total)}</div><div class="name">VLM 已审核</div></div>
    <div class="card"><div class="num" style="color:var(--danger)">${st.vlm.mismatch}</div><div class="name">VLM 判不匹配</div></div>
    <div class="card"><div class="num" style="color:var(--amber)">${st.vlm.error}</div><div class="name">调用错误</div></div>
    <div class="card"><div class="num" style="color:var(--primary)">${rv.reviewed}</div><div class="name">已人工复核</div></div>
    <div class="card"><div class="num" style="color:var(--green)">${rv.confirm}</div><div class="name">确认判断</div></div>
    <div class="card"><div class="num" style="color:var(--danger)">${rv.override}</div><div class="name">人工改判</div></div>
    <div class="card"><div class="num">${st.classified}</div><div class="name">分类标注数</div></div>`;

  const maxC = Math.max(...st.top_cats.map(c => c.count), 1);
  $("#dash-cats").innerHTML = st.top_cats.map(c => `
    <div class="bar-row">
      <span class="bname">${esc(c.name)}</span>
      <div class="btrack"><div class="bfill" style="width:${c.count / maxC * 100}%"></div></div>
      <span class="bval">${fmtSize(c.count)}</span>
    </div>`).join("");

  const v = st.vlm;
  const vrows = [
    ["匹配", v.match, "var(--green)"], ["不匹配", v.mismatch, "var(--danger)"],
    ["错误", v.error, "var(--amber)"], ["未复核总量", v.total - rv.reviewed, "#64748b"],
  ];
  const maxV = Math.max(...vrows.map(r => r[1]), 1);
  $("#dash-vlm").innerHTML = vrows.map(([n, c, col]) => `
    <div class="bar-row">
      <span class="bname">${n}</span>
      <div class="btrack"><div class="bfill" style="width:${c / maxV * 100}%;background:${col}"></div></div>
      <span class="bval">${fmtSize(c)}</span>
    </div>`).join("");

  $("#dash-recent").innerHTML = st.recent.length
    ? st.recent.map(r => `
      <div class="recent-item">
        <img src="${imgUrl(r.image, true)}" loading="lazy">
        <span class="badge ${r.decision === "confirm" ? "match" : r.decision === "override" ? "mismatch" : "error"}">
          ${{ confirm: "确认", override: "改判", uncertain: "存疑" }[r.decision] || r.decision}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.image)}</span>
      </div>`).join("")
    : `<p class="muted">暂无复核记录</p>`;
}

// ==================== 图片 ====================
async function initImageLine() {
  if (!S.tree) S.tree = await api("/api/tree");
  await loadEditorLabels(true);   // 弹层标签集：项目导入标签优先，未配置时兜底内置
  loadPreviewStats();
  if (S.imgMode === "label") {
    if (!$("#label-tree").children.length) {
      renderTree($("#label-tree"), { onPick: (n) => openDir(n.path) });
    }
  } else if (!S.rvQueue.length) {
    loadReviewQueue();
  }
  chatGreeting("image");
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + units[i];
}

// 预览模式：数据集概览（格式 / 尺寸 / 体积）
let previewStatsLoaded = false;
async function loadPreviewStats(force = false) {
  const box = $("#preview-stats");
  if (previewStatsLoaded && !force) return;
  box.style.display = "";
  box.innerHTML = `<p class="muted">数据集统计中…</p>`;
  const r = await api("/api/dataset/preview");
  if (r.error) { box.innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  previewStatsLoaded = true;
  const im = r.images, sz = im.sizes || {};
  const fmtHtml = (im.formats || []).map(([k, v]) =>
    `<span class="probe-chip">${esc(k)} <b>${fmtSize(v)}</b></span>`).join("");
  box.innerHTML = `
    <div class="preview-stats-row">
      <span class="ps-item">🖼️ 图片 <b>${fmtSize(im.count)}</b> 张</span>
      <span class="ps-item">💾 总体积 <b>${fmtBytes(im.total_bytes)}</b></span>
      <span class="ps-item">📐 尺寸 <b>${sz.avg_w || "-"}×${sz.avg_h || "-"}</b>（均） ·
        <b>${sz.min_w || "-"}~${sz.max_w || "-"}</b> 宽 · <b>${sz.min_h || "-"}~${sz.max_h || "-"}</b> 高
        <span class="muted" style="font-size:11px">抽样 ${sz.sampled || 0} 张</span></span>
      <span class="ps-item ps-formats">📦 格式 ${fmtHtml || '<span class="muted">无</span>'}</span>
      <span class="ps-item">📄 文本 <b>${fmtSize(r.texts.count)}</b> 个文件 / ${r.texts.dirs} 个目录</span>
    </div>`;
}

function setImgMode(mode) {
  S.imgMode = mode;
  $("#img-mode-label").classList.toggle("active", mode === "label");
  $("#img-mode-review").classList.toggle("active", mode === "review");
  $("#img-pane-label").style.display = mode === "label" ? "" : "none";
  $("#img-pane-review").style.display = mode === "review" ? "" : "none";
  $("#img-mode-label-tools").style.display = mode === "label" ? "" : "none";
  $("#img-mode-review-tools").style.display = mode === "review" ? "" : "none";
  $("#dir-stats").style.display = mode === "label" ? "" : "none";
  if (mode === "review") {
    if (!S.rvQueue.length) loadReviewQueue();
  } else if (!$("#label-tree").children.length) {
    renderTree($("#label-tree"), { onPick: (n) => openDir(n.path) });
  }
}
$("#img-mode-label").addEventListener("click", () => setImgMode("label"));
$("#img-mode-review").addEventListener("click", () => setImgMode("review"));

// ---- 标注模式：目录树 + 网格 ----
async function openDir(dirPath) {
  S.curDir = dirPath;
  S.gridOffset = 0;
  S.gridItems = [];
  $("#cur-dir").innerHTML = dirPath
    ? dirPath.split("/").map(s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join(' <span class="sep">›</span> ')
    : "（根目录）";
  await loadGrid();
}

async function loadGrid() {
  const unlab = $("#unlabeled-only").checked ? 1 : 0;
  const r = await api(`/api/label/images?dir=${encodeURIComponent(S.curDir)}&offset=${S.gridOffset}&limit=60&unlabeled_only=${unlab}`);
  if (r.error) { toast(r.error, false); return; }
  S.gridTotal = r.total;
  S.gridItems = r.items;
  $("#dir-stats").textContent = `共 ${r.total} 张`;
  const grid = $("#img-grid");
  if (S.gridOffset === 0) grid.innerHTML = "";
  grid.insertAdjacentHTML("beforeend", r.items.map(it => {
    const clsTitle = `${it.classified}${it.classify_by ? " · 标注人：" + it.classify_by : ""}`;
    const clsBadge = it.classify_status === "confirmed"
      ? `<span class="badge match" title="${esc(clsTitle)}">类</span>`
      : it.classified ? `<span class="badge error" title="${esc(clsTitle)}">待确认</span>` : "";
    return `
    <div class="img-cell" data-rel="${esc(it.image)}">
      <div class="cell-badges">
        ${it.has_boxes ? `<span class="badge done" title="${it.boxes_by ? "框标注人：" + esc(it.boxes_by) : "有框标注"}">框</span>` : ""}
        ${clsBadge}
        ${it.reviewed ? `<span class="badge gray">核</span>` : ""}
      </div>
      <img src="${imgUrl(it.image, true)}" loading="lazy">
      <div class="cell-name">${esc(it.name)}</div>
    </div>`;
  }).join(""));
  $$("#img-grid .img-cell").forEach(el =>
    el.addEventListener("click", () => openEditor(el.dataset.rel)));
  $("#btn-more").style.display =
    S.gridOffset + r.items.length < r.total ? "" : "none";
  S.gridOffset += r.items.length;
}

$("#btn-more").addEventListener("click", loadGrid);
$("#unlabeled-only").addEventListener("change", () => {
  S.gridOffset = 0;
  loadGrid();
});

// ---- 批量 VLM 预标注（启动前确认 + 运行中可停止） ----
async function pollPendingCount() {
  // 统计当前目录未标注数量（大目录约需十几秒）
  const el = $("#bvlm-pending");
  const r = await api(`/api/label/batch_vlm/pending?dir=${encodeURIComponent(S.curDir || "")}`);
  if (!r.ok) { el.textContent = "统计失败"; return; }
  el.textContent = `${r.count} 张`;
}

$("#btn-batch-vlm").addEventListener("click", async () => {
  const st = await api("/api/label/batch_vlm/status");
  if (st.running) {
    toast(`批量预标注进行中：${st.done}/${st.total}`, true);
    $("#batch-vlm-stop").style.display = "";
    return;
  }
  $("#bvlm-dir").textContent = S.curDir || "整个数据源";
  $("#bvlm-pending").textContent = "统计中…";
  $("#batch-vlm-modal").style.display = "flex";
  pollPendingCount();
});

$("#bvlm-cancel").onclick = () => { $("#batch-vlm-modal").style.display = "none"; };

$("#bvlm-go").onclick = async () => {
  const limit = +$("#bvlm-limit").value;
  const r = await api(`/api/label/batch_vlm?dir=${encodeURIComponent(S.curDir)}&limit=${limit}&workers=4`, { method: "POST" });
  if (r.error) return toast(r.error, false);
  if (r.started === 0) return toast(r.message || "没有未标注图片", false);
  $("#batch-vlm-modal").style.display = "none";
  $("#batch-vlm-stop").style.display = "";
  $("#btn-batch-clear").style.display = "";
  toast(`已启动批量预标注：${r.started} 张，可随时点「停止」`);
  pollBatchVlm();
};

// ---- 删除批量预标注结果 ----
function pollClearCount() {
  const scope = $("#bclear-scope").value;
  const dir = scope === "dir" ? (S.curDir || "") : "";
  const el = $("#bclear-count");
  el.textContent = "统计中…";
  api(`/api/label/batch_vlm/clear_count?dir=${encodeURIComponent(dir)}`)
    .then(r => { el.textContent = r.ok ? `${r.count} 条` : "统计失败"; });
}

$("#btn-batch-clear").onclick = () => {
  $("#bclear-scope").value = S.curDir ? "dir" : "all";
  $("#bclear-count").textContent = "统计中…";
  $("#batch-clear-modal").style.display = "flex";
  pollClearCount();
};

$("#bclear-scope").onchange = pollClearCount;
$("#bclear-cancel").onclick = () => { $("#batch-clear-modal").style.display = "none"; };

$("#bclear-go").onclick = async () => {
  const scope = $("#bclear-scope").value;
  const dir = scope === "dir" ? (S.curDir || "") : "";
  const r = await api("/api/label/batch_vlm/clear", { method: "POST", body: { dir } });
  if (!r.ok) return toast(r.error || "删除失败", false);
  $("#batch-clear-modal").style.display = "none";
  toast(`已删除 ${r.removed} 条预标注`);
  if (S.view === "image" && S.imgMode === "label") {
    S.gridOffset = 0;
    loadGrid();
  }
};

$("#batch-vlm-stop").onclick = async () => {
  const r = await api("/api/label/batch_vlm/stop", { method: "POST" });
  if (r.stopped) toast(`正在停止…已完成 ${r.done}/${r.total}`);
  else toast(r.message || "当前没有进行中的批量预标注", false);
};

function pollBatchVlm() {
  if (S.batchTimer) clearInterval(S.batchTimer);
  S.batchTimer = setInterval(async () => {
    const st = await api("/api/label/batch_vlm/status");
    $("#batch-vlm-status").textContent =
      ` 预标注 ${st.done}/${st.total}（错误 ${st.errors}）`;
    if (!st.running && st.total) {
      clearInterval(S.batchTimer);
      S.batchTimer = null;
      $("#batch-vlm-stop").style.display = "none";
      $("#batch-vlm-status").textContent += st.stop ? " · 已停止" : " · 完成";
      if (S.view === "image" && S.imgMode === "label") {
        S.gridOffset = 0;
        loadGrid();
      }
    }
  }, 2000);
}

// ==================== 复核模式（图片） ====================
async function loadReviewQueue() {
  const f = S.rvFilters;
  const q = encodeURIComponent(f.q);
  const r = await api(`/api/review/queue?status=${f.status}&result=${f.result}&q=${q}`);
  S.rvQueue = r.items;
  const c = r.counts;
  $("#rv-counts").innerHTML = `
    <span>队列 ${S.rvQueue.length}</span><span>待复核 ${c.pending}</span>
    <span>不匹配 <b style="color:var(--danger)">${c.mismatch}</b></span>
    <span>错误 ${c.error}</span><span>低置信 ${c.low}</span>`;
  renderRvList();
  if (S.rvQueue.length) selectRvItem(0);
  else $("#rv-detail").innerHTML = `<div class="rv-empty">队列为空，可先在标注模式「批量预标注」，或换个筛选条件</div>`;
}

function renderRvList() {
  $("#rv-list").innerHTML = S.rvQueue.map((it, i) => {
    const badge = it.match === true
      ? `<span class="badge ${it.confidence < 0.7 ? "error" : "match"}">匹配${it.confidence < 0.7 ? "(低)" : ""}</span>`
      : it.match === false ? `<span class="badge mismatch">不匹配</span>`
      : `<span class="badge error">错误</span>`;
    const done = it.reviewed
      ? `<span class="badge done">${{ confirm: "已确认", override: "已改判", uncertain: "存疑" }[it.my_decision] || ""}</span>` : "";
    return `
    <div class="rv-item ${i === S.rvIdx ? "active" : ""}" data-i="${i}">
      <img src="${imgUrl(it.image, true)}" loading="lazy">
      <div class="rv-meta">
        <div class="rv-label">${esc(it.label_path)}</div>
        <div class="rv-file">${esc(it.image.split("/").pop())}</div>
        <div class="rv-badges">${badge}${done}</div>
      </div>
    </div>`;
  }).join("");
  $$("#rv-list .rv-item").forEach(el =>
    el.addEventListener("click", () => selectRvItem(+el.dataset.i)));
}

async function selectRvItem(i) {
  S.rvIdx = i;
  const it = S.rvQueue[i];
  $$("#rv-list .rv-item").forEach((el, j) => el.classList.toggle("active", j === i));
  const cur = $("#rv-list .rv-item.active");
  if (cur) cur.scrollIntoView({ block: "nearest" });

  const boxes = await api(`/api/boxes?image=${encodeURIComponent(it.image)}`);
  const vlmBadge = it.match === true ? "badge match" : it.match === false ? "badge mismatch" : "badge error";
  const vlmText = it.match === true ? `匹配 (${it.confidence})` : it.match === false ? `不匹配 (${it.confidence})` : "调用错误";

  $("#rv-detail").innerHTML = `
  <div class="rv-detail-card">
    <div class="rv-img-wrap">
      <img id="rv-img" src="${imgUrl(it.image)}" alt="">
      <canvas id="rv-overlay"></canvas>
    </div>
    <div class="rv-info">
      <div class="kv"><div class="k">目录标签</div><div class="v">${esc(it.label_path)}</div></div>
      ${it.label_by ? `<div class="kv"><div class="k">标注人</div><div class="v">${esc(it.label_by)}</div></div>` : ""}
      <div class="kv"><div class="k">VLM 判断</div><div class="v"><span class="${vlmBadge}">${vlmText}</span></div></div>
      <div class="kv"><div class="k">VLM 理由</div><div class="v">${esc(it.error || it.reason)}</div></div>
      <div class="kv"><div class="k">实际内容</div><div class="v">${esc(it.actual_content || "-")}</div></div>
      <div class="kv"><div class="k">VLM 建议标签</div><div class="v">${esc(it.suggested_label || "-")}</div></div>
      ${it.reviewed ? `<div class="kv"><div class="k">我的复核</div><div class="v">
        <span class="badge done">${{ confirm: "已确认", override: "已改判", uncertain: "存疑" }[it.my_decision]}</span>
        ${it.my_label ? " → " + esc(it.my_label) : ""}${it.my_by ? ` · 复核人：${esc(it.my_by)}` : ""}</div></div>` : ""}
      <div class="rv-actions">
        <button class="btn confirm-btn" data-act="confirm">✔ 确认 VLM 判断<span class="kbd">1</span></button>
        <button class="btn override-btn" data-act="override">✏ 改判（换标签）<span class="kbd">2</span></button>
        <button class="btn uncertain-btn" data-act="uncertain">? 标记存疑<span class="kbd">3</span></button>
        <div id="rv-override-panel" style="display:none">
          <div class="kv">
            <div class="k">正确标签（从目录树选择）</div>
            <div id="rv-override-picker" class="cascader"></div>
            <button class="btn primary sm" id="rv-override-save" style="margin-top:6px">提交改判</button>
          </div>
        </div>
        ${it.reviewed ? `<button class="btn sm" id="rv-undo">撤销复核</button>` : ""}
      </div>
      <div class="nav-btns">
        <button class="btn" id="rv-prev">‹ 上一张</button>
        <span class="muted">${i + 1} / ${S.rvQueue.length}</span>
        <button class="btn" id="rv-next">下一张 ›</button>
      </div>
    </div>
  </div>`;

  const img = $("#rv-img"), cv = $("#rv-overlay");
  img.onload = () => drawReadOnlyBoxes(img, cv, boxes.shapes);
  if (img.complete) drawReadOnlyBoxes(img, cv, boxes.shapes);

  $$("#rv-detail .rv-actions [data-act]").forEach(b =>
    b.addEventListener("click", () => doDecide(b.dataset.act)));
  $("#rv-prev").addEventListener("click", () => selectRvItem(Math.max(0, S.rvIdx - 1)));
  $("#rv-next").addEventListener("click", () => selectRvItem(Math.min(S.rvQueue.length - 1, S.rvIdx + 1)));
  const undo = $("#rv-undo");
  if (undo) undo.addEventListener("click", async () => {
    await api(`/api/review/reset?image=${encodeURIComponent(it.image)}`, { method: "POST" });
    toast("已撤销");
    loadReviewQueue();
  });
}

// 框坐标归一化为一维 [x1,y1,x2,y2]；兼容旧嵌套 [[x1,y1],[x2,y2]]
function normCoords(c) {
  if (Array.isArray(c) && c.length === 4) return c;
  if (Array.isArray(c) && c.length === 2 && Array.isArray(c[0]) && Array.isArray(c[1]))
    return [c[0][0], c[0][1], c[1][0], c[1][1]];
  return null;
}

function drawReadOnlyBoxes(img, cv, shapes) {
  const dispW = img.clientWidth, dispH = img.clientHeight;
  if (!dispW) return;
  cv.width = dispW; cv.height = dispH;
  cv.style.width = dispW + "px"; cv.style.height = dispH + "px";
  cv.style.left = img.offsetLeft + "px"; cv.style.top = img.offsetTop + "px";
  const ctx = cv.getContext("2d");
  const sx = dispW / img.naturalWidth, sy = dispH / img.naturalHeight;
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (const s of shapes) {
    ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(34,211,238,.85)";
    const label = s.label || "";
    ctx.font = "12px sans-serif";
    const tw = ctx.measureText(label).width + 8;
    if (s.shapeType === "line") {
      const c = Array.isArray(s.coordinates) && s.coordinates.length === 4 ? s.coordinates : null;
      if (!c) continue;
      ctx.beginPath();
      ctx.moveTo(c[0] * sx, c[1] * sy); ctx.lineTo(c[2] * sx, c[3] * sy); ctx.stroke();
      ctx.fillRect(c[0] * sx, Math.max(0, c[1] * sy - 16), tw, 16);
      ctx.fillStyle = "#0f172a";
      ctx.fillText(label, c[0] * sx + 4, Math.max(12, c[1] * sy - 4));
      continue;
    }
    const [x1, y1, x2, y2] = normCoords(s.coordinates) || [0, 0, 0, 0];
    ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
    ctx.fillRect(x1 * sx, Math.max(0, y1 * sy - 16), tw, 16);
    ctx.fillStyle = "#0f172a";
    ctx.fillText(label, x1 * sx + 4, Math.max(12, y1 * sy - 4));
  }
}

async function doDecide(act) {
  const it = S.rvQueue[S.rvIdx];
  if (act === "override") {
    const panel = $("#rv-override-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block" && !$("#rv-override-picker").children.length) {
      renderCascader($("#rv-override-picker"), "", (p) => { panel.dataset.picked = p; });
    }
    $("#rv-override-save").onclick = async () => {
      const picked = panel.dataset.picked || "";
      if (!picked) return toast("请先选择正确标签", false);
      await api("/api/review/decide", {
        method: "POST",
        body: { image: it.image, decision: "override", label_path: picked.replace(/\//g, " > ") },
      });
      toast("已提交改判");
      advance();
    };
    return;
  }
  const labels = { confirm: "", uncertain: "" };
  await api("/api/review/decide", {
    method: "POST",
    body: { image: it.image, decision: act, label_path: labels[act] },
  });
  toast(act === "confirm" ? "已确认" : "已标记存疑");
  advance();
}

function advance() {
  // 待复核模式下当前项会消失，直接刷新
  if (S.rvFilters.status === "pending") {
    const nextIdx = Math.min(S.rvIdx, S.rvQueue.length - 2);
    loadReviewQueue().then(() => {
      if (S.rvQueue.length) selectRvItem(Math.max(0, nextIdx));
    });
  } else {
    loadReviewQueue().then(() => selectRvItem(S.rvIdx));
  }
}

$("#rv-filter-status").addEventListener("change", e => { S.rvFilters.status = e.target.value; loadReviewQueue(); });
$("#rv-filter-result").addEventListener("change", e => { S.rvFilters.result = e.target.value; loadReviewQueue(); });
let rvSearchTimer;
$("#rv-search").addEventListener("input", e => {
  clearTimeout(rvSearchTimer);
  rvSearchTimer = setTimeout(() => { S.rvFilters.q = e.target.value.trim(); loadReviewQueue(); }, 300);
});

// 复核模式键盘快捷键
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (S.view === "image" && S.imgMode === "review" && S.rvIdx >= 0) {
    if (e.key === "1") doDecide("confirm");
    else if (e.key === "2") doDecide("override");
    else if (e.key === "3") doDecide("uncertain");
    else if (e.key === "ArrowLeft") selectRvItem(Math.max(0, S.rvIdx - 1));
    else if (e.key === "ArrowRight") selectRvItem(Math.min(S.rvQueue.length - 1, S.rvIdx + 1));
  }
});

// ==================== 级联标签选择器 ====================
function renderCascader(container, value = "", onPick = () => {}, rootTree = null, sep = "/", onClear = null) {
  container.innerHTML = "";
  container.dataset.picked = value;
  const tree = rootTree || S.tree;
  if (!tree || !tree.children || !tree.children.length) {
    container.innerHTML = `<span class="muted">目录分类为空，请先导入数据</span>`;
    return;
  }
  const levels = value ? value.split(sep).map(s => s.trim()).filter(Boolean) : [];

  function findNode(path) {
    let found = null;
    (function walk(n) {
      if (n.path === path) { found = n; return; }
      n.children.forEach(walk);
    })(tree);
    return found;
  }

  function addLevel(nodeList, levelIdx) {
    if (!nodeList.length) return;
    const target = levels.slice(0, levelIdx + 1).join(sep);
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">— 选择 —</option>` + nodeList.map(n =>
      `<option value="${esc(n.path)}" ${n.path === target ? "selected" : ""}>
       ${esc(n.name)}</option>`).join("");
    sel.addEventListener("change", () => {
      while (container.lastElementChild !== sel) container.lastElementChild.remove();
      const node = findNode(sel.value);
      container.dataset.picked = sel.value;
      onPick(sel.value);
      if (node && node.children.length) addLevel(node.children, levelIdx + 1);
    });
    container.appendChild(sel);
    if (target) {
      const node = findNode(target);
      if (node && node.children.length) addLevel(node.children, levelIdx + 1);
    }
  }

  // 已有标注路径：显示面包屑（可读），点「重新选择」才展开级联下拉
  if (levels.length) {
    const crumb = document.createElement("span");
    crumb.className = "crumb-path";
    crumb.innerHTML = levels.map((l, i) =>
      `<span class="crumb-seg" title="${esc(value)}">${esc(l)}</span>`
      + (i < levels.length - 1 ? `<span class="crumb-sep">›</span>` : "")
    ).join("");
    container.appendChild(crumb);
    const edit = document.createElement("button");
    edit.className = "btn sm";
    edit.textContent = "重新选择";
    edit.addEventListener("click", () => {
      container.dataset.picked = "";
      onPick("");
      renderCascader(container, "", onPick, rootTree, sep, onClear);
    });
    container.appendChild(edit);
    if (onClear) {
      const clear = document.createElement("button");
      clear.className = "btn sm danger-link";
      clear.textContent = "清除标注";
      clear.addEventListener("click", () => onClear());
      container.appendChild(clear);
    }
    return;
  }

  addLevel(tree.children, 0);
}

// ==================== 树渲染（图片目录树） ====================
function renderTree(container, opts = {}) {
  const { onPick, activePath = "", filter = "" } = opts;
  container.innerHTML = "";

  function matchesPath(node) {
    if (!filter) return true;
    if (node.path.includes(filter)) return true;
    return node.children.some(matchesPath);
  }

  function build(node, depth) {
    if (node.total === 0 && depth > 0) return null;
    if (filter && !matchesPath(node)) return null;
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const hasKids = node.children.some(c => matchesPath(c) && (c.total ?? 1) > 0);
    const row = document.createElement("div");
    row.className = "tree-row" + (node.path === activePath ? " active" : "");
    row.innerHTML = `
      <span class="tree-toggle">${hasKids ? "▼" : ""}</span>
      <span class="folder-icon">${depth === 0 ? "📁" : "📂"}</span>
      <span>${esc(node.name)}</span>
      <span class="cnt">${node.total !== undefined ? node.total : ""}</span>`;
    row.addEventListener("click", (e) => {
      const isToggle = e.target.classList.contains("tree-toggle");
      if (kidsDiv.children.length && (isToggle || kidsDiv.style.display === "none")) {
        kidsDiv.style.display = kidsDiv.style.display === "none" ? "" : "none";
        const tg = row.querySelector(".tree-toggle");
        if (tg) tg.textContent = kidsDiv.style.display === "none" ? "▶" : "▼";
        if (isToggle) return;
      }
      container.querySelectorAll(".tree-row").forEach(r => r.classList.remove("active"));
      row.classList.add("active");
      onPick(node);
    });
    wrap.appendChild(row);
    const kidsDiv = document.createElement("div");
    kidsDiv.className = "tree-children";
    if (filter) kidsDiv.style.display = "";
    else if (depth < 1) kidsDiv.style.display = "";
    else kidsDiv.style.display = depth < 1 ? "" : "none";
    for (const c of node.children) {
      const cw = build(c, depth + 1);
      if (cw) kidsDiv.appendChild(cw);
    }
    if (kidsDiv.children.length) wrap.appendChild(kidsDiv);
    else row.querySelector(".tree-toggle").textContent = "";
    return wrap;
  }

  for (const c of S.tree.children) {
    const w = build(c, 0);
    if (w) container.appendChild(w);
  }
}

// ==================== 画框编辑器 ====================
class BoxEditor {
  constructor(canvas, wrap, labelGetter = null) {
    this.cv = canvas;
    this.wrap = wrap;
    this.labelGetter = labelGetter;   // 可选：自定义当前标签来源（独立标注页用）
    this.ctx = canvas.getContext("2d");
    this.img = null;
    this.scale = 1;
    this.fitScale = 1;   // 适应窗口的基础缩放（滚轮缩放的基准）
    this.shapes = [];        // 框 {label,x1,y1,x2,y2} / 点 {label,x,y,pt:true} / 线 {label,x1,y1,x2,y2,line:true}，原图坐标
    this.selected = -1;
    this.mode = null;
    this.drag = null;
    this.showBoxes = true;
    this.readOnly = false;
    this.tool = "box";       // box=画框（拖动）| point=点标注（单击加点）| line=线标注（两点画线）
    this.anchor = null;      // N 键锚点拉框：[ix, iy] 原图坐标（null=未锚定）
    this.anchorCur = null;   // 锚点预览的当前光标位置（显示坐标）
    this.lastMouse = null;   // 最近一次光标位置（显示坐标，N 键锚定用）
    this.lineStart = null;   // 线标注：第一点（原图坐标，null=未定起点）
    this.lineCur = null;     // 线标注预览：当前光标位置（显示坐标）
    this.bindEvents();
  }

  setTool(t) {
    this.tool = ["point", "line"].includes(t) ? t : "box";
    this.lineStart = null; this.lineCur = null;   // 切工具废弃未完成的线
    this.draw();
  }

  // 当前新形状使用的标签
  curLabel() {
    if (this.labelGetter) return (this.labelGetter() || "").trim() || "object";
    return ($("#ed-box-label").value || "").trim() || "object";
  }

  setImage(img, hOff = 330) {
    this.img = img;
    this.anchor = null;      // 换图清除 N 键锚点（坐标跨图无效）
    this.anchorCur = null;
    this.lastMouse = null;
    this.lineStart = null;   // 换图清除未完成的线
    this.lineCur = null;
    // 优先按容器实际尺寸 fit（编辑器弹层为固定大小容器，画布恒定、弹层不随图片大小变化）；
    // 容器不可见/未布局完成时回退按视口估算
    const cw = this.wrap.clientWidth - 24, ch = this.wrap.clientHeight - 24;
    const maxW = cw > 60 ? cw : Math.min(this.wrap.clientWidth - 24, 1100);
    const maxH = ch > 60 ? ch : window.innerHeight - hOff;
    this.fitScale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    this.setScale(this.fitScale);
  }

  // 缩放画布（scale 变更 + 重设画布尺寸 + 重绘）
  setScale(scale) {
    this.scale = scale;
    this.cv.width = Math.round(this.img.naturalWidth * this.scale);
    this.cv.height = Math.round(this.img.naturalHeight * this.scale);
    this.draw();
  }

  resetZoom() {
    if (this.img && this.fitScale) this.setScale(this.fitScale);
  }

  setShapes(shapes) {
    this.shapes = (shapes || []).map(s => {
      if (s.shapeType === "point" && Array.isArray(s.coordinates) && s.coordinates.length === 2) {
        return { label: s.label, x: +s.coordinates[0] || 0, y: +s.coordinates[1] || 0, pt: true };
      }
      if (s.shapeType === "line" && Array.isArray(s.coordinates) && s.coordinates.length === 4) {
        return { label: s.label, x1: +s.coordinates[0] || 0, y1: +s.coordinates[1] || 0, x2: +s.coordinates[2] || 0, y2: +s.coordinates[3] || 0, line: true };
      }
      const [x1, y1, x2, y2] = normCoords(s.coordinates) || [0, 0, 0, 0];
      return { label: s.label, x1, y1, x2, y2 };
    });
    this.selected = -1;
    this.draw();
  }

  toDisp(x, y) { return [x * this.scale, y * this.scale]; }
  toImg(dx, dy) { return [dx / this.scale, dy / this.scale]; }

  // 光标到线段的屏幕距离（命中判断用，端点钳位）
  distToSeg(mx, my, s) {
    const [ax, ay] = this.toDisp(s.x1, s.y1);
    const [bx, by] = this.toDisp(s.x2, s.y2);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / len2)) : 0;
    return Math.hypot(mx - (ax + t * dx), my - (ay + t * dy));
  }

  hitHandle(mx, my) {
    const s = this.shapes[this.selected];
    if (!s || s.pt) return null;   // 点无拖角调整（整体拖动即可）
    if (s.line) {
      // 线：两端点可拖动调整（p1=起点 p2=终点）
      const [ax, ay] = this.toDisp(s.x1, s.y1);
      const [bx, by] = this.toDisp(s.x2, s.y2);
      if (Math.abs(mx - ax) < 8 && Math.abs(my - ay) < 8) return "p1";
      if (Math.abs(mx - bx) < 8 && Math.abs(my - by) < 8) return "p2";
      return null;
    }
    const [x1, y1] = this.toDisp(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2));
    const [x2, y2] = this.toDisp(Math.max(s.x1, s.x2), Math.max(s.y1, s.y2));
    const pts = {
      nw: [x1, y1], n: [(x1 + x2) / 2, y1], ne: [x2, y1], e: [x2, (y1 + y2) / 2],
      se: [x2, y2], s: [(x1 + x2) / 2, y2], sw: [x1, y2], w: [x1, (y1 + y2) / 2],
    };
    for (const [k, [px, py]] of Object.entries(pts)) {
      if (Math.abs(mx - px) < 7 && Math.abs(my - py) < 7) return k;
    }
    return null;
  }

  // 宽松命中：形状内部任意处（用于单击选中与双击改标签；点用 14px 半径）
  hitShapeInner(mx, my) {
    const [ix, iy] = this.toImg(mx, my);
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.pt) {
        const [dx, dy] = this.toDisp(s.x, s.y);
        if (Math.hypot(mx - dx, my - dy) <= 14) return i;
      } else if (s.line) {
        if (this.distToSeg(mx, my, s) <= 12) return i;
      } else {
        const L = Math.min(s.x1, s.x2), R = Math.max(s.x1, s.x2);
        const T = Math.min(s.y1, s.y2), B = Math.max(s.y1, s.y2);
        if (ix >= L && ix <= R && iy >= T && iy <= B) return i;
      }
    }
    return -1;
  }

  hitShape(mx, my) {
    // 大框只吃边框附近的点击（选中/拖动），内部穿透 —— 否则导入的大框（如验证码框）
    // 遮住图片区域，框内无法画新框/加点；点按屏幕距离（9px）命中，小框整体可点
    const [ix, iy] = this.toImg(mx, my);
    const px = 1 / (this.scale || 1);
    const tol = 6 * px;                          // 屏幕 6px 容差换算原图
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.pt) {
        const [dx, dy] = this.toDisp(s.x, s.y);
        if (Math.hypot(mx - dx, my - dy) <= 9) return i;
        continue;
      }
      if (s.line) {
        if (this.distToSeg(mx, my, s) <= 9) return i;
        continue;
      }
      const L = Math.min(s.x1, s.x2), R = Math.max(s.x1, s.x2);
      const T = Math.min(s.y1, s.y2), B = Math.max(s.y1, s.y2);
      if (ix < L - tol || ix > R + tol || iy < T - tol || iy > B + tol) continue;
      const small = (R - L) < 24 * px && (B - T) < 24 * px;   // 屏幕上 <24px 视为「点」
      const onBorder = ix <= L + tol || ix >= R - tol || iy <= T + tol || iy >= B - tol;
      if (small || onBorder || i === this.selected) return i;
    }
    return -1;
  }

  pos(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  bindEvents() {
    const cv = this.cv;
    cv.addEventListener("mousedown", (e) => {
      if (this.readOnly || !this.img) return;
      const [mx, my] = this.pos(e);
      if (this.anchor && this.tool === "box") {
        // N 键锚点拉框：从锚点出发直接进入画框，光标为另一端
        const [ax, ay] = this.toDisp(this.anchor[0], this.anchor[1]);
        this.anchor = null; this.anchorCur = null;
        this.selected = -1;
        this.mode = "draw";
        this.drag = { mx: ax, my: ay, cur: [mx, my] };
        this.draw(this.drag);
        e.preventDefault();
        return;
      }
      const handle = this.hitHandle(mx, my);
      if (handle && this.selected >= 0) {
        // 待定手势：落点在角点上——需拖动超过阈值才真正进入 resize，
        // 防止「点一下角点」被误判成拖角导致框突然变形
        this.mode = "maybeResize";
        this.drag = { handle, mx, my, orig: { ...this.shapes[this.selected] } };
      } else {
        const idx = this.hitShape(mx, my);
        if (idx >= 0) {
          this.selected = idx;
          this.mode = "move";
          const [ix, iy] = this.toImg(mx, my);
          const s = this.shapes[idx];
          this.drag = s.pt ? { ix, iy, orig: { x: s.x, y: s.y } }
                           : { ix, iy, orig: { ...s } };
          this.emitChange();
        } else if (this.tool === "point") {
          // 点标注模式：单击空白 = 以当前标签加点，随即处于拖动态可微调位置
          const [ix, iy] = this.toImg(mx, my);
          const s = { label: this.curLabel(), x: ix, y: iy, pt: true };
          this.shapes.push(s);
          this.selected = this.shapes.length - 1;
          this.mode = "move";
          this.drag = { ix, iy, orig: { x: s.x, y: s.y } };
          this.emitChange();
        } else if (this.tool === "line") {
          // 线标注模式：两点画线——第一次点击定起点（移动鼠标实时预览），第二次点击定终点成线
          const [ix, iy] = this.toImg(mx, my);
          if (!this.lineStart) {
            this.lineStart = [ix, iy];
            this.lineCur = [mx, my];
          } else {
            const [sx, sy] = this.toDisp(this.lineStart[0], this.lineStart[1]);
            if (Math.hypot(mx - sx, my - sy) > 6) {   // 屏幕距离 >6px 才成线（防双击/原地连点误触）
              this.shapes.push({ label: this.curLabel(), x1: this.lineStart[0], y1: this.lineStart[1], x2: ix, y2: iy, line: true });
              this.selected = this.shapes.length - 1;
              this.emitChange();
            }
            this.lineStart = null; this.lineCur = null;   // 未达阈值 = 取消本次画线
          }
        } else {
          const inner = this.hitShapeInner(mx, my);
          if (inner >= 0) {
            // 待定手势：落点在形状内部——松开 = 选中该形状（随后整体可拖动/双击改标签）；
            // 拖动超过阈值 = 升级为画框（保留大框内部穿透绘制的语义）
            this.selected = -1;
            this.mode = "maybe";
            this.drag = { mx, my, inner };
          } else {
            this.selected = -1;
            this.mode = "draw";
            this.drag = { mx, my };
          }
        }
      }
      this.draw();
      e.preventDefault();
    });

    cv.addEventListener("mousemove", (e) => {
      const [mx, my] = this.pos(e);
      this.lastMouse = [mx, my];
      if (this.anchor) { this.anchorCur = [mx, my]; this.draw(); }   // N 键锚定中：实时预览锚点→光标
      if (this.lineStart) { this.lineCur = [mx, my]; this.draw(); }  // 线标注定起点后：实时预览起点→光标直线
      if (!this.drag || !this.img) return;
      if (this.mode === "draw") {
        this.drag.cur = [mx, my];
        this.draw(this.drag);
      } else if (this.mode === "maybe") {
        // 拖动超过 4px：确认为「在形状内部画新框」穿透手势
        if (Math.hypot(mx - this.drag.mx, my - this.drag.my) > 4) {
          this.mode = "draw";
          this.drag = { mx: this.drag.mx, my: this.drag.my, cur: [mx, my] };
        }
        this.draw(this.drag);
      } else if (this.mode === "maybeResize") {
        // 拖动超过 4px 才真正进入角点调整；原地松开 = 无操作
        if (Math.hypot(mx - this.drag.mx, my - this.drag.my) > 4) {
          this.mode = "resize";
          this.draw();
        }
      } else if (this.mode === "move") {
        const [ix, iy] = this.toImg(mx, my);
        const s = this.shapes[this.selected], o = this.drag.orig;
        const dx = ix - this.drag.ix, dy = iy - this.drag.iy;
        if (s.pt) { s.x = o.x + dx; s.y = o.y + dy; }
        else { s.x1 = o.x1 + dx; s.x2 = o.x2 + dx; s.y1 = o.y1 + dy; s.y2 = o.y2 + dy; }
        this.draw();
      } else if (this.mode === "resize") {
        const [ix, iy] = this.toImg(mx, my);
        const s = this.shapes[this.selected], o = this.drag.orig, h = this.drag.handle;
        if (h === "p1") { s.x1 = ix; s.y1 = iy; }        // 线：拖起点
        else if (h === "p2") { s.x2 = ix; s.y2 = iy; }   // 线：拖终点
        else {
          if (h.includes("w")) { s.x1 = ix; }
          if (h.includes("e")) { s.x2 = ix; }
          if (h.includes("n")) { s.y1 = iy; }
          if (h.includes("s")) { s.y2 = iy; }
        }
        this.draw();
      }
    });

    const finish = (cancel = false) => {
      if (!this.drag) return;
      if (!cancel && this.mode === "maybe") {
        // 原地松开 = 选中待定形状（内部任意处单击即可选中，便于随后整体拖动/双击改标签）
        this.selected = this.drag.inner;
        this.emitChange();
      } else if (!cancel && this.mode === "draw") {
        // 仅拖出 >6×6 才建框；单击/微拖不生成任何形状（点标注请切「◉ 点标注」工具）
        if (this.drag.cur) {
          const [ix, iy] = this.toImg(this.drag.mx, this.drag.my);
          const [x2, y2] = this.toImg(this.drag.cur[0], this.drag.cur[1]);
          const w = Math.abs(x2 - ix), h = Math.abs(y2 - iy);
          if (w > 6 && h > 6) {
            this.shapes.push({ label: this.curLabel(), x1: ix, y1: iy, x2, y2 });
            this.selected = this.shapes.length - 1;
            this.emitChange();
          }
        }
      } else if (!cancel && (this.mode === "move" || this.mode === "resize")) {
        this.emitChange();
      }
      this.drag = null; this.mode = null;
      this.draw();
    };
    cv.addEventListener("mouseup", () => finish(false));
    cv.addEventListener("mouseleave", () => finish(true));

    cv.addEventListener("dblclick", (e) => {
      if (this.readOnly) return;
      const [mx, my] = this.pos(e);
      // 宽松命中：双击形状内部任意处即可改标签（严格命中只认边框，大框内部难以触发）
      let idx = this.hitShape(mx, my);
      if (idx < 0) idx = this.hitShapeInner(mx, my);
      if (idx >= 0) {
        this.selected = idx;
        const cur = this.shapes[idx].label;
        const nl = prompt("修改标签（英文）:", cur);
        if (nl !== null && nl.trim()) {
          this.shapes[idx].label = nl.trim();
          ensureEdLabel(nl.trim(), false);   // 新标签进标签集（会话内可见）
          this.emitChange();
          this.draw();
        }
      }
    });

    // 滚轮缩放：以光标为锚点放大/缩小，缩放后修正滚动使锚点不漂移
    cv.addEventListener("wheel", (e) => {
      if (!this.img) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const lo = Math.max(this.fitScale * 0.25, 0.02);
      const hi = this.fitScale * 8;
      const ns = Math.min(Math.max(this.scale * factor, lo), hi);
      if (ns === this.scale) return;
      const r = this.cv.getBoundingClientRect();
      const ix = (e.clientX - r.left) / this.scale;   // 光标处图像坐标
      const iy = (e.clientY - r.top) / this.scale;
      this.setScale(ns);
      requestAnimationFrame(() => {
        const wr = this.wrap.getBoundingClientRect();
        const nr = this.cv.getBoundingClientRect();
        // 画布原点在滚动内容中的偏移（含居中 margin），反推 scroll 使锚点回到光标处
        const offX = nr.left - wr.left + this.wrap.scrollLeft;
        const offY = nr.top - wr.top + this.wrap.scrollTop;
        this.wrap.scrollLeft = ix * ns + offX - (e.clientX - wr.left);
        this.wrap.scrollTop = iy * ns + offY - (e.clientY - wr.top);
      });
    }, { passive: false });

    document.addEventListener("keydown", (e) => {
      // 仅当本编辑器画布可见时响应（兼容编辑器弹窗与独立标注页双实例）
      if (this.readOnly || !this.img || this.cv.clientWidth === 0) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected >= 0) {
        this.shapes.splice(this.selected, 1);
        this.selected = -1;
        this.emitChange();
        this.draw();
        e.preventDefault();
      } else if (e.key === "Escape") {
        this.selected = -1;
        this.anchor = null; this.anchorCur = null;
        this.lineStart = null; this.lineCur = null;   // Esc 取消未完成的线
        this.draw();
      } else if ((e.key === "n" || e.key === "N") && this.tool === "box") {
        // N 键：以当前光标位置为锚点，随后按下鼠标拖动即可拉出框；再按 N 取消
        if (this.anchor) {
          this.anchor = null; this.anchorCur = null;
        } else {
          const p = this.lastMouse;
          if (p) this.anchor = this.toImg(p[0], p[1]);
        }
        this.draw();
        e.preventDefault();
      }
    });
  }

  onChange = null;
  emitChange() { if (this.onChange) this.onChange(this.shapes); }

  draw(draft) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    if (this.img) ctx.drawImage(this.img, 0, 0, this.cv.width, this.cv.height);
    if (!this.showBoxes) return;

    const drawBox = (s, i) => {
      const sel = i === this.selected;
      ctx.font = "bold 13px sans-serif";
      const label = `${s.label}`;
      const tw = ctx.measureText(label).width + 10;
      if (s.pt) {
        // 点：圆点标记 + 标签（选中放大加圈）
        const [dx, dy] = this.toDisp(s.x, s.y);
        if (sel) {
          ctx.beginPath(); ctx.arc(dx, dy, 10, 0, Math.PI * 2);
          ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(dx, dy, sel ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = sel ? "#facc15" : "#22d3ee";
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#0f172a"; ctx.stroke();
        const ly = Math.max(0, dy - 22);
        ctx.fillStyle = sel ? "#facc15" : "rgba(34,211,238,.9)";
        ctx.fillRect(dx + 8, ly, tw, 18);
        ctx.fillStyle = "#0f172a";
        ctx.fillText(label, dx + 13, ly + 14);
        return;
      }
      if (s.line) {
        // 线：线段 + 端点方块 + 标签（起点上方）
        const [dx1, dy1] = this.toDisp(s.x1, s.y1);
        const [dx2, dy2] = this.toDisp(s.x2, s.y2);
        ctx.strokeStyle = sel ? "#facc15" : "#a78bfa";
        ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath(); ctx.moveTo(dx1, dy1); ctx.lineTo(dx2, dy2); ctx.stroke();
        const ly = Math.max(0, dy1 - 18);
        ctx.fillStyle = sel ? "#facc15" : "rgba(167,139,250,.9)";
        ctx.fillRect(dx1, ly, tw, 18);
        ctx.fillStyle = "#0f172a";
        ctx.fillText(label, dx1 + 5, ly + 14);
        for (const [px, py] of [[dx1, dy1], [dx2, dy2]]) {
          ctx.fillStyle = sel ? "#fff" : "#a78bfa";
          ctx.fillRect(px - 3, py - 3, 6, 6);
          ctx.lineWidth = 2; ctx.strokeStyle = "#0f172a"; ctx.strokeRect(px - 3, py - 3, 6, 6);
        }
        return;
      }
      const [dx1, dy1] = this.toDisp(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2));
      const [dx2, dy2] = this.toDisp(Math.max(s.x1, s.x2), Math.max(s.y1, s.y2));
      ctx.strokeStyle = sel ? "#facc15" : "#22d3ee";
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeRect(dx1, dy1, dx2 - dx1, dy2 - dy1);
      const ly = Math.max(0, dy1 - 18);
      ctx.fillStyle = sel ? "#facc15" : "rgba(34,211,238,.9)";
      ctx.fillRect(dx1, ly, tw, 18);
      ctx.fillStyle = "#0f172a";
      ctx.fillText(label, dx1 + 5, ly + 14);
      if (sel) {
        ctx.fillStyle = "#fff";
        const pts = [
          [dx1, dy1], [(dx1 + dx2) / 2, dy1], [dx2, dy1], [dx2, (dy1 + dy2) / 2],
          [dx2, dy2], [(dx1 + dx2) / 2, dy2], [dx1, dy2], [dx1, (dy1 + dy2) / 2],
        ];
        for (const [px, py] of pts) {
          ctx.fillRect(px - 3, py - 3, 6, 6);
          ctx.strokeRect(px - 3, py - 3, 6, 6);
        }
      }
    };

    this.shapes.forEach(drawBox);
    if (draft && draft.cur) {
      const x1 = Math.min(draft.mx, draft.cur[0]);
      const y1 = Math.min(draft.my, draft.cur[1]);
      const x2 = Math.max(draft.mx, draft.cur[0]);
      const y2 = Math.max(draft.my, draft.cur[1]);
      ctx.strokeStyle = "#f472b6"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
    }
    // 线标注进行中：起点圆点标记 + 起点→当前光标的虚线预览直线
    if (this.lineStart) {
      const [ax, ay] = this.toDisp(this.lineStart[0], this.lineStart[1]);
      ctx.strokeStyle = "#f472b6"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ax, ay, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#f472b6"; ctx.fill();
      ctx.stroke();
      if (this.lineCur) {
        const [cx, cy] = this.lineCur;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // N 键锚点：粉色十字标记 + 锚点→当前光标的虚线预览框
    if (this.anchor) {
      const [ax, ay] = this.toDisp(this.anchor[0], this.anchor[1]);
      ctx.strokeStyle = "#f472b6"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay);
      ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10);
      ctx.stroke();
      if (this.anchorCur) {
        const [cx, cy] = this.anchorCur;
        const x1 = Math.min(ax, cx), y1 = Math.min(ay, cy);
        const x2 = Math.max(ax, cx), y2 = Math.max(ay, cy);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.setLineDash([]);
      }
    }
  }
}

// ---------- 编辑器流程 ----------
// ==================== 编辑器标签集（图片页点开图片的弹层：展示标签，点击=设为当前框标签） ====================
const ED_LBL = { cfg: null, labels: [], imported: new Set(), expanded: false };

async function loadEditorLabels(force) {
  // 标签集来源融合：标注配置 labels ∪ 数据导入 imported_labels；两者全空才兜底内置 EN_LABELS
  if (force || !ED_LBL.cfg) {
    const r = await api("/api/annotate/config");
    ED_LBL.cfg = (r && !r.error && r.config) || {};
  }
  const cfg = ED_LBL.cfg;
  const merged = [...new Set([
    ...(Array.isArray(cfg.labels) ? cfg.labels : []),
    ...(Array.isArray(cfg.imported_labels) ? cfg.imported_labels : []),
  ])].map(l => (l || "").trim()).filter(Boolean);
  ED_LBL.labels = merged.length ? merged : EN_LABELS.slice();
  ED_LBL.imported = new Set(merged.length ? (cfg.imported_labels || []) : []);
  renderEdLabels();
}

function syncEdLabelActive() {
  const cur = ($("#ed-box-label").value || "").trim();
  $$("#ed-label-grid .lg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.l === cur));
  ensureActiveLabelVisible("#ed-label-grid");
}

function renderEdLabels() {
  const grid = $("#ed-label-grid");
  if (!grid) return;
  // 展示标签（📦=数据导入 · ✏=手动创建），点击 = 设为当前框标签
  grid.innerHTML = ED_LBL.labels.map(l =>
    `<button class="lg-btn" data-l="${esc(l)}">${esc(l)}<span class="lg-src ${ED_LBL.imported.has(l) ? "imp" : "man"}" title="${ED_LBL.imported.has(l) ? "数据导入" : "手动创建"}">${ED_LBL.imported.has(l) ? "导" : "手"}</span></button>`).join("");
  grid.querySelectorAll(".lg-btn").forEach(b =>
    b.addEventListener("click", () => {
      const lbl = b.dataset.l;
      $("#ed-box-label").value = lbl;
      // 有选中形状时：点标签 = 直接改该形状标签（否则仅设为当前绘制标签）
      if (S.editor && S.editor.selected >= 0 && S.editor.shapes[S.editor.selected]) {
        S.editor.shapes[S.editor.selected].label = lbl;
        S.editor.draw();
        renderBoxList(S.editor.shapes);
      }
      syncEdLabelActive();
    }));
  // 标签过多时收起（弹层为多列网格，阈值取 12）
  appendLabelToggle(grid, ED_LBL.labels.length, 12, ED_LBL.expanded,
    () => { ED_LBL.expanded = !ED_LBL.expanded; renderEdLabels(); });
  // 框标签输入候选与默认值同步（仅输入为空时填默认，不覆盖用户输入的自定义标签）
  $("#en-labels").innerHTML = ED_LBL.labels.map(l => `<option value="${esc(l)}">`).join("");
  const inp = $("#ed-box-label");
  if (!(inp.value || "").trim()) inp.value = ED_LBL.labels[0] || "";
  syncEdLabelActive();
}

// 新标签并入弹层标签集；persist=true 时静默写回标注配置（跨会话保留）
async function ensureEdLabel(lbl, persist) {
  lbl = (lbl || "").trim();
  if (!lbl) return;
  if (ED_LBL.labels.includes(lbl)) { syncEdLabelActive(); return; }
  ED_LBL.labels.push(lbl);
  renderEdLabels();
  if (!persist) return;
  const cfg = ED_LBL.cfg || {};
  // 内置兜底标签不落盘：未配置过标签集时只持久化真实使用的标签，避免把整份 EN_LABELS 写进配置
  const toSave = (Array.isArray(cfg.labels) && cfg.labels.length)
    ? ED_LBL.labels : ED_LBL.labels.filter(l => !EN_LABELS.includes(l));
  const r = await api("/api/annotate/config", {
    method: "POST",
    body: {
      line: cfg.line || "image", task_type: cfg.task_type || "classify",
      format: cfg.format || "txt", start: cfg.start || 1, group: cfg.group || 50,
      labels: [...new Set(toSave)],
    },
  });
  if (!r.error && r.config) ED_LBL.cfg = r.config;   // 同步最新配置（含服务端维护的 imported_labels）
}

// 当前图形状里的标签并入标签集（会话内可见，旧标注的标签不会在 chips 里找不到）
function mergeEdShapeLabels(shapes) {
  let added = false;
  (shapes || []).forEach(s => {
    const l = ((s && s.label) || "").trim();
    if (l && !ED_LBL.labels.includes(l)) { ED_LBL.labels.push(l); added = true; }
  });
  if (added) renderEdLabels();
}

// 新增标签入口：输入框回车 / 失焦 / 「＋ 新增标签」按钮
$("#ed-box-label").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  ensureEdLabel(e.target.value, true);   // 回车 = 入集并持久化
});
$("#ed-box-label").addEventListener("blur", (e) => ensureEdLabel(e.target.value, false));   // 失焦 = 仅入会话集
$("#ed-label-add").addEventListener("click", () => ensureEdLabel($("#ed-box-label").value, true));
// mousedown 阻止输入框先行失焦：否则 blur 先把标签入会话集，按钮 click 的持久化 POST 被 includes 短路
[$("#ed-label-add"), $("#ed-label-grid")].forEach(el =>
  el.addEventListener("mousedown", (e) => e.preventDefault()));

async function openEditor(rel) {
  S.editQueue = [...$$("#img-grid .img-cell")].map(el => el.dataset.rel);
  S.editQueueIdx = S.editQueue.indexOf(rel);
  await showEditor(rel);
}

async function showEditor(rel) {
  const modal = $("#editor-modal");
  modal.style.display = "flex";
  if (!ED_LBL.labels.length) await loadEditorLabels(true);   // 兜底：确保弹层标签集已就绪

  if (!S.editor) {
    S.editor = new BoxEditor($("#ed-canvas"), $("#ed-canvas-wrap"));
    S.editor.onChange = renderBoxList;
  }
  // 加载守卫：rel 置空（保存守卫/editorDirty 拒发），清空旧图 shapes 防止窗口期误存到新图
  const seq = (S._edSeq = (S._edSeq || 0) + 1);   // 竞态 token：连点翻页时旧请求结果作废
  S.editor.rel = "";
  S.editor.setShapes([]);
  renderBoxList([]);
  // 工具状态跟随按钮（会话内保持，换图不重置）
  S.editor.setTool(["point", "line"].find(t => $(`#ed-tool-${t}`).classList.contains("active")) || "box");
  $("#ed-title").textContent = rel;
  $("#ed-by").textContent = "";       // 异步加载归属前先清空，避免残留

  const img = new Image();
  img.src = imgUrl(rel);
  let loaded = true;
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  } catch { loaded = false; }
  if (S._edSeq !== seq) return;       // 已切到别的图，本请求作废
  if (!loaded) {                      // 图片加载失败：提示并关闭弹层（rel 仍为空，保存守卫拒发）
    toast(`图片加载失败：${rel}`, false);
    modal.style.display = "none";
    return;
  }
  S.editor.setImage(img);

  const boxes = await api(`/api/boxes?image=${encodeURIComponent(rel)}`);
  if (S._edSeq !== seq) return;
  // 接口异常响应无 shapes：按空处理，避免 setShapes 抛 TypeError
  S.editor.setShapes(Array.isArray(boxes.shapes) ? boxes.shapes : []);
  mergeEdShapeLabels(S.editor.shapes);   // 该图已有形状的标签并入标签集
  S.editor._original = JSON.parse(JSON.stringify(S.editor.shapes));
  S.editor.rel = rel;                 // 数据就绪后才认领新图（此前保存一律拒绝）
  renderBoxList(S.editor.shapes);

  const gridItem = S.gridItems.find(g => g.image === rel) || {};
  // 归属展示（协作 P2）：标注人
  const boxBy = boxes.updated_by || gridItem.boxes_by || "";
  $("#ed-by").textContent = boxBy ? `（标注：${boxBy}）` : "";

  refreshCellBadge(rel, S.editor.shapes.length > 0);   // 打开时同步网格「框」徽标
}

// 形状摘要：框 [宽×高] / 点 [点 x,y] / 线 [线 长]
function shapeDesc(s) {
  if (s.pt) return `[点 ${Math.round(s.x)},${Math.round(s.y)}]`;
  if (s.line) return `[线 长${Math.round(Math.hypot(s.x2 - s.x1, s.y2 - s.y1))}]`;
  return `[${Math.round(Math.abs(s.x2 - s.x1))}×${Math.round(Math.abs(s.y2 - s.y1))}]`;
}

// shapes -> POST /api/boxes body（框/线 4 标量 / 点 2 标量）
function shapesToBody(shapes) {
  return shapes.map(s => s.pt
    ? { label: s.label, shapeType: "point", coordinates: [Math.round(s.x), Math.round(s.y)] }
    : s.line
      ? {
        label: s.label, shapeType: "line",
        coordinates: [Math.round(s.x1), Math.round(s.y1), Math.round(s.x2), Math.round(s.y2)],
      }
      : {
        label: s.label, shapeType: "rectangle",
        coordinates: [
          Math.round(Math.min(s.x1, s.x2)), Math.round(Math.min(s.y1, s.y2)),
          Math.round(Math.max(s.x1, s.x2)), Math.round(Math.max(s.y1, s.y2)),
        ],
      });
}

function renderBoxList(shapes) {
  const wrap = $("#ed-box-list");
  wrap.innerHTML = shapes.length
    ? shapes.map((s, i) => `
      <span class="box-chip ${i === S.editor.selected ? "selected" : ""}" data-i="${i}">
        ${esc(s.label)} ${s.pt ? "◉" : s.line ? "╱" : "◻"} ${shapeDesc(s)}
        <span class="x" data-del="${i}">×</span>
      </span>`).join("")
    : `<span class="muted">暂无标注</span>`;
  wrap.querySelectorAll(".box-chip").forEach(ch => {
    ch.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) {
        S.editor.shapes.splice(+e.target.dataset.del, 1);
        S.editor.selected = -1;
        S.editor.draw();
        renderBoxList(S.editor.shapes);
        return;
      }
      S.editor.selected = +ch.dataset.i;
      S.editor.draw();
      renderBoxList(S.editor.shapes);
    });
  });
}

$("#ed-close").addEventListener("click", async () => {
  if (!await saveEditorSilent()) return;   // 关闭前自动保存（失败不关闭，防丢标注）
  $("#editor-modal").style.display = "none";
});
$("#ed-prev").addEventListener("click", () => stepEditor(-1));
$("#ed-next").addEventListener("click", () => stepEditor(1));

// 弹层：当前图标注相对加载时是否有改动（增/删/改都会体现）
function editorDirty() {
  if (!S.editor || !S.editor.rel) return false;
  const o = S.editor._original;
  if (!o) return S.editor.shapes.length > 0;
  return JSON.stringify(shapesToBody(S.editor.shapes)) !== JSON.stringify(shapesToBody(o));
}

// 弹层：静默保存（有改动才发请求），翻页/关闭前调用；返回 false = 有改动但保存失败
async function saveEditorSilent() {
  if (!editorDirty()) return true;
  const relAt = S.editor.rel;         // 发送时快照：响应回来核对（窗口期 rel 为空时 editorDirty 已拦）
  const r = await api("/api/boxes", {
    method: "POST",
    body: { image: relAt, shapes: shapesToBody(S.editor.shapes) },
  });
  if (S.editor.rel !== relAt) return true;   // 期间已切图：落盘成功即可，不更新新图基准
  if (r.ok) {
    S.editor._original = JSON.parse(JSON.stringify(S.editor.shapes));
    refreshCellBadge(relAt, true);
    toast(`已自动保存 ${r.saved} 个标注 → ${relAt}`);
    return true;
  }
  toast(r.error || "自动保存失败", false);
  return false;
}

async function stepEditor(d) {
  if (S._edStepping) return;          // 防重入：自动保存/加载未完成时忽略连点
  S._edStepping = true;
  try {
    const n = S.editQueueIdx + d;
    if (n < 0 || n >= S.editQueue.length) return toast("没有更多图片了", false);
    if (!await saveEditorSilent()) return;   // 翻页前自动保存当前图，失败不翻页（防丢）
    S.editQueueIdx = n;
    await showEditor(S.editQueue[n]);
  } finally { S._edStepping = false; }
}

$("#ed-reset").addEventListener("click", () => {
  if (!S.editor._original) return;
  S.editor.setShapes(JSON.parse(JSON.stringify(S.editor._original)));
  S.editor.resetZoom();
  renderBoxList(S.editor.shapes);
  toast("已还原为加载数据");
});

$("#ed-toggle-boxes").addEventListener("click", (e) => {
  S.editor.showBoxes = !S.editor.showBoxes;
  e.target.textContent = S.editor.showBoxes ? "隐藏标注" : "显示标注";
  S.editor.draw();
});

// 弹层工具切换：几何标注 / 点标注 / 线标注
const ED_HINTS = {
  box: "拖动画框 · 单击框内选中（选中后整体拖动）· 拖角点调大小 · 双击框内改标签 · N 键锚定起点拉框（再按 N 取消）· Delete 删除 · 滚轮缩放",
  point: "单击画布加点 · 拖动微调 · 双击改标签 · Delete 删除 · 滚轮缩放 · 选中后点标签改标签",
  line: "点一下定起点 · 移动鼠标预览直线 · 再点一下定终点成线 · 点线选中（整体拖动/拖端点调整）· 双击改标签 · Esc 取消 · Delete 删除",
};
function setEdTool(t) {
  $("#ed-tool-box").classList.toggle("active", t === "box");
  $("#ed-tool-point").classList.toggle("active", t === "point");
  $("#ed-tool-line").classList.toggle("active", t === "line");
  $("#ed-tool-hint").textContent = ED_HINTS[t];
  if (S.editor) S.editor.setTool(t);
}
$("#ed-tool-box").addEventListener("click", () => setEdTool("box"));
$("#ed-tool-point").addEventListener("click", () => setEdTool("point"));
$("#ed-tool-line").addEventListener("click", () => setEdTool("line"));

$("#ed-save-boxes").addEventListener("click", async () => {
  if (!S.editor || !S.editor.rel) return toast("图片加载中，请稍候再保存", false);   // 加载窗口期守卫，防旧图串存
  const relAt = S.editor.rel;         // 发送时快照：响应回来核对是否仍是同一张图
  const r = await api("/api/boxes", {
    method: "POST",
    body: { image: relAt, shapes: shapesToBody(S.editor.shapes) },
  });
  if (S.editor.rel !== relAt) return; // 保存期间已切图：不更新基准/角标（服务器已落盘，切回时重载）
  if (r.ok) {
    S.editor._original = JSON.parse(JSON.stringify(S.editor.shapes));
    toast(`已保存 ${r.saved} 个标注 → ${r.file}`);
    refreshCellBadge(relAt, true);
  } else toast(r.error || "保存失败", false);
});

function refreshCellBadge(rel, hasBoxes) {
  const cell = $(`#img-grid .img-cell[data-rel="${CSS.escape(rel)}"]`);
  if (!cell) return;
  if (hasBoxes === true && !cell.querySelector(".badge.done")) {
    cell.querySelector(".cell-badges").insertAdjacentHTML("beforeend", `<span class="badge done">框</span>`);
  }
}

// ==================== 文本 ====================
async function initTextLine() {
  if (S.txtMode === "src") {
    if (!S.txtTree) await loadTxtTree();
    if (!$("#txt-lines").children.length) loadTxtLines();
  } else {
    tlLoadList();
    tlPollVlm(false);
  }
  chatGreeting("text");
}

function setTxtMode(mode) {
  S.txtMode = mode;
  $("#txt-mode-src").classList.toggle("active", mode === "src");
  $("#txt-mode-pool").classList.toggle("active", mode === "pool");
  $("#txt-pane-src").style.display = mode === "src" ? "" : "none";
  $("#txt-pane-pool").style.display = mode === "pool" ? "" : "none";
  $("#txt-src-tools").style.display = mode === "src" ? "" : "none";
  $("#txt-pool-tools").style.display = mode === "pool" ? "" : "none";
  if (mode === "src") {
    if (!S.txtTree) loadTxtTree();
    if (!$("#txt-lines").children.length) loadTxtLines();
  } else {
    tlLoadList();
  }
}
$("#txt-mode-src").addEventListener("click", () => setTxtMode("src"));
$("#txt-mode-pool").addEventListener("click", () => setTxtMode("pool"));

async function loadTxtTree() {
  const t = await api("/api/text/tree");
  if (t.error) { $("#txt-tree").innerHTML = `<p class="muted">${esc(t.error)}</p>`; return; }
  S.txtTree = t;
  const c = $("#txt-tree");
  c.innerHTML = "";
  const mkRow = (node, depth) => {
    const row = document.createElement("div");
    row.className = "tree-row" + (node.path === S.txtDir ? " active" : "");
    row.innerHTML = `<span class="folder-icon">${depth === 0 ? "📁" : "📂"}</span>
      <span>${esc(node.name)}</span><span class="cnt">${node.total ?? node.count}</span>`;
    row.addEventListener("click", () => {
      S.txtDir = node.path;
      $("#txt-dir-filter").value = node.path;
      c.querySelectorAll(".tree-row").forEach(r => r.classList.remove("active"));
      row.classList.add("active");
      loadTxtLines();
    });
    c.appendChild(row);
    for (const ch of node.children || []) mkRow(ch, depth + 1);
  };
  mkRow(t, 0);
}

async function loadTxtLines() {
  const dir = $("#txt-dir-filter").value.trim();
  S.txtDir = dir;
  const r = await api(`/api/text/lines?dir=${encodeURIComponent(dir)}&offset=0&limit=200`);
  if (r.error) { $("#txt-lines").innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  $("#txt-src-stats").textContent = `${dir ? "「" + dir + "」" : "全部"}共 ${fmtSize(r.total)} 行（预览前200）`;
  $("#txt-lines").innerHTML = r.items.length ? r.items.map(l => `
    <div class="txt-line-row">
      <div class="txt-line-text">${esc(l.text)}</div>
      <div class="txt-line-meta">${esc(l.label_path)}${l.en ? " · " + esc(l.en) : ""}${l.code ? " · " + esc(l.code) : ""}</div>
    </div>`).join("")
    : `<p class="muted" style="padding:10px">该目录没有文本行</p>`;
}

let txtDirTimer;
$("#txt-dir-filter").addEventListener("input", e => {
  clearTimeout(txtDirTimer);
  txtDirTimer = setTimeout(loadTxtLines, 300);
});

$("#btn-import-texts").addEventListener("click", async () => {
  const dir = $("#txt-dir-filter").value.trim();
  const btn = $("#btn-import-texts");
  btn.disabled = true;
  const r = await api("/api/text/import", { method: "POST", body: { dir, limit: 100000 } });
  btn.disabled = false;
  if (r.ok) {
    toast(`已导入 ${r.added} 条（重复 ${r.duplicated}），池共 ${r.total} 条`);
    chatAdd("text", "assistant",
      `已把${dir ? "「" + dir + "」" : "全部"}文本导入标注池：新增 ${r.added} 条，重复跳过 ${r.duplicated} 条，池共 ${r.total} 条。需要我发起 LLM 批量预标注吗？`);
    chatRender("text");
  } else toast(r.error || "导入失败", false);
});

// ---- 文本标注池 ----
$("#tl-add").addEventListener("click", async () => {
  const raw = $("#tl-textarea").value;
  const texts = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!texts.length) return toast("请先输入文本", false);
  const r = await api("/api/text_pool/add", { method: "POST", body: { texts } });
  if (r.ok) {
    $("#tl-add-msg").textContent = ` 新增 ${r.added} 条，重复跳过 ${r.duplicated} 条`;
    $("#tl-textarea").value = "";
    tlLoadList();
  } else toast(r.error || "添加失败", false);
});

$("#tl-vlm").addEventListener("click", async () => {
  const r = await api("/api/text_pool/vlm?workers=4&limit=100", { method: "POST" });
  if (r.error) return toast(r.error, false);
  if (r.started === 0) return toast(r.message || "没有待预标注的文本");
  toast(`已启动预标注：${r.started} 条`);
  tlPollVlm(true);
});

function tlPollVlm(active) {
  if (S.tl.vlmTimer) clearInterval(S.tl.vlmTimer);
  S.tl.vlmTimer = setInterval(async () => {
    const st = await api("/api/text_pool/vlm/status");
    $("#tl-vlm-status").textContent =
      st.total ? ` 预标注 ${st.done}/${st.total}（错误 ${st.errors}）` : "";
    if (active && !st.running && st.total) {
      clearInterval(S.tl.vlmTimer);
      S.tl.vlmTimer = null;
      $("#tl-vlm-status").textContent += " · 完成";
      tlLoadList();
    }
  }, 2000);
}

async function tlLoadList() {
  const r = await api(`/api/text_pool/list?status=${S.tl.filter}&q=${encodeURIComponent(S.tl.q)}`);
  if (r.error) { $("#tl-list").innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  S.tl.labels = r.labels || [];

  // 标签下拉（按一级分组）
  const groups = {};
  for (const p of S.tl.labels) {
    const top = p.split(" > ")[0];
    (groups[top] = groups[top] || []).push(p);
  }
  const opts = Object.keys(groups).sort().map(g =>
    `<optgroup label="${esc(g)}">` + groups[g].map(p =>
      `<option value="${esc(p)}">${esc(p)}</option>`).join("") + `</optgroup>`).join("");

  $("#tl-list").innerHTML = r.items.length ? r.items.map(it => `
    <div class="tl-row ${it.status === "confirmed" ? "tl-confirmed" : ""}" data-id="${it.id}">
      <div class="tl-text">${esc(it.text)}${it.status === "confirmed" && it.by ? ` <span class="muted" style="font-size:11px">· ${esc(it.by)}</span>` : ""}</div>
      <div class="tl-label">
        <select class="tl-select" data-id="${it.id}">
          <option value="">— 选择标签 —</option>
          ${opts}
        </select>
      </div>
      <div class="tl-vlm">${it.vlm
        ? (it.vlm.error
          ? `<span class="badge error">失败</span> <span class="muted">${esc(it.vlm.error.slice(0, 40))}</span>`
          : `<span class="badge done" title="${esc(it.vlm.reason || "")}">VLM ${(it.vlm.confidence ?? "")}</span> ${esc(it.vlm.label_path || "")}`)
        : `<span class="muted">未预标</span>`}</div>
      <div class="tl-ops">
        <button class="btn primary sm tl-confirm" data-id="${it.id}">确认</button>
        <button class="btn danger sm tl-del" data-id="${it.id}">删</button>
      </div>
    </div>`).join("")
    : `<div class="panel"><p class="muted">标注池为空：在「数据目录」选好后点「导入到标注池」，或在上方手动添加</p></div>`;

  $$(".tl-select").forEach(sel => {
    const it = r.items.find(x => x.id === sel.dataset.id);
    if (it && it.label_path) sel.value = it.label_path;
  });

  $$(".tl-confirm").forEach(b => b.addEventListener("click", async () => {
    const sel = $(`.tl-select[data-id="${b.dataset.id}"]`);
    const lp = sel.value;
    if (!lp) return toast("请先选择标签", false);
    const r2 = await api("/api/text_pool/decide", {
      method: "POST", body: { id: b.dataset.id, label_path: lp },
    });
    if (r2.ok) { toast("已确认"); tlLoadList(); }
  }));

  $$(".tl-del").forEach(b => b.addEventListener("click", async () => {
    await api(`/api/text_pool/delete?id=${b.dataset.id}`, { method: "POST" });
    tlLoadList();
  }));
}

$("#tl-filter").addEventListener("change", e => { S.tl.filter = e.target.value; tlLoadList(); });
let tlSearchTimer;
$("#tl-search").addEventListener("input", e => {
  clearTimeout(tlSearchTimer);
  tlSearchTimer = setTimeout(() => { S.tl.q = e.target.value.trim(); tlLoadList(); }, 300);
});

$("#tl-export").addEventListener("click", async () => {
  const r = await api("/api/text_pool/export", { method: "POST" });
  if (r.ok) toast(`已导出 ${r.confirmed} 条确认结果`);
  else toast(r.error || "导出失败", false);
});

// ==================== AI 助手（对话式引导） ====================
const CHAT = {
  image: { msgs: [], busy: false, greeted: false },
  text: { msgs: [], busy: false, greeted: false },
};

function chatGreeting(line) {
  const c = CHAT[line];
  if (c.greeted || c.msgs.length || !S.probe) return;
  c.greeted = true;
  const p = S.probe;
  const imgs = p.images || {}, roles = p.roles || {}, txts = p.texts || {};
  let text;
  if (line === "image") {
    const hasAnn = !!(roles.checkpoint || roles.json_root || (roles.results_jsons || []).length);
    const topCats = imgs.top_cats || [];
    const nCats = Array.isArray(topCats) ? topCats.length : Object.keys(topCats).length;
    text = `已解析数据：${fmtSize(imgs.count || 0)} 张图片，${nCats} 个一级目录。` +
      (hasAnn
        ? "检测到已有标注文件，历史结果已加载。"
        : "**未发现标注文件**。需要我对图片做 AI 自动预标注吗？") +
      "\n左侧可浏览图片，也可以直接告诉我你想做什么：";
    chatAdd(line, "assistant", text);
    chatSetChips(line, hasAnn
      ? ["批量预标注图片", "打开复核台"]
      : ["帮我自动预标注", "批量预标注图片", "打开复核台"]);
  } else {
    text = txts.count
      ? `检测到 ${fmtSize(txts.count)} 行文本，分布在 ${txts.dirs || 0} 个目录。可在左侧浏览文本，或让我把它们导入标注池进行 LLM 预标注。`
      : "本数据集中没有发现 txt 文本。你也可以在标注池视图手动粘贴文本加入。";
    chatAdd(line, "assistant", text);
    chatSetChips(line, txts.count
      ? ["导入文本到标注池", "批量预标注文本池", "导出结果"]
      : ["批量预标注文本池", "导出结果"]);
  }
  chatRender(line);
}

function chatSetChips(line, chips) {
  $(`#ai-chips-${line}`).innerHTML = chips.map(t =>
    `<button class="chip" data-q="${esc(t)}">${esc(t)}</button>`).join("");
  $$(`#ai-chips-${line} .chip`).forEach(b =>
    b.addEventListener("click", () => {
      $(`#ai-input-${line}`).value = b.dataset.q;
      chatSend(line);
    }));
}

function chatAdd(line, role, text) {
  CHAT[line].msgs.push({ role, text, ts: Date.now() });
}

function chatRender(line) {
  const box = $(`#ai-msgs-${line}`);
  box.innerHTML = CHAT[line].msgs.map(m => `
    <div class="ai-msg ${m.role === "user" ? "me" : "bot"}">
      <div class="ai-bubble">${esc(m.text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div>
    </div>`).join("")
    + (CHAT[line].busy ? `<div class="ai-msg bot"><div class="ai-bubble muted">思考中…</div></div>` : "");
  box.scrollTop = box.scrollHeight;
}

async function chatSend(line) {
  const input = $(`#ai-input-${line}`);
  const text = input.value.trim();
  if (!text || CHAT[line].busy) return;
  input.value = "";
  chatAdd(line, "user", text);
  CHAT[line].busy = true;
  chatRender(line);
  const r = await api("/api/assistant", {
    method: "POST",
    body: {
      message: text, line,
      history: CHAT[line].msgs.slice(-7, -1).map(m => ({ role: m.role, content: m.text })),
    },
  });
  CHAT[line].busy = false;
  if (r.ok) {
    chatAdd(line, "assistant", r.reply);
    if (r.action && r.action !== "none") await execAction(line, r.action, r.args || {});
  } else {
    chatAdd(line, "assistant", "出错了：" + (r.error || "未知错误"));
  }
  chatRender(line);
}

$("#ai-send-image").addEventListener("click", () => chatSend("image"));
$("#ai-send-text").addEventListener("click", () => chatSend("text"));
$("#ai-input-image").addEventListener("keydown", e => { if (e.key === "Enter") chatSend("image"); });
$("#ai-input-text").addEventListener("keydown", e => { if (e.key === "Enter") chatSend("text"); });
$("#ai-clear-image").addEventListener("click", () => {
  CHAT.image = { msgs: [], busy: false, greeted: false };
  $("#ai-msgs-image").innerHTML = ""; $("#ai-chips-image").innerHTML = "";
  chatGreeting("image");
});
$("#ai-clear-text").addEventListener("click", () => {
  CHAT.text = { msgs: [], busy: false, greeted: false };
  $("#ai-msgs-text").innerHTML = ""; $("#ai-chips-text").innerHTML = "";
  chatGreeting("text");
});

async function execAction(line, action, args) {
  const say = (t) => { chatAdd(line, "assistant", t); };
  if (action === "start_batch_label") {
    nav("image");
    setImgMode("label");
    const dir = args.dir || "";
    const limit = args.limit || 200;
    const r = await api(`/api/label/batch_vlm?dir=${encodeURIComponent(dir)}&limit=${limit}&workers=4`, { method: "POST" });
    if (r.error) return say("批量预标注启动失败：" + r.error);
    if (r.started === 0) return say(r.message || "没有需要预标注的图片");
    say(`已启动批量预标注：${r.started} 张（目录：${dir || "全部"}）。完成后可到「复核模式」检查结果，可随时点工具栏「停止」。`);
     $("#batch-vlm-stop").style.display = "";
     $("#btn-batch-clear").style.display = "";
     pollBatchVlm();
  } else if (action === "open_review") {
    nav("image");
    setImgMode("review");
    say("已切换到复核模式，左侧队列可逐张确认或改判（快捷键 1/2/3）。");
  } else if (action === "import_texts") {
    nav("text");
    setTxtMode("src");
    const r = await api("/api/text/import", { method: "POST", body: { dir: args.dir || "", limit: args.limit || 100000 } });
    if (r.ok) {
      say(`已把${args.dir ? "「" + args.dir + "」" : "全部"}文本导入标注池：新增 ${r.added} 条，重复跳过 ${r.duplicated} 条，池共 ${r.total} 条。需要我现在发起 LLM 批量预标注吗？`);
      loadTxtLines();
    } else {
      say("导入失败：" + (r.error || "未知错误"));
    }
  } else if (action === "batch_label_texts") {
    nav("text");
    setTxtMode("pool");
    const r = await api(`/api/text_pool/vlm?workers=4&limit=${args.limit || 100}`, { method: "POST" });
    if (r.error) return say("预标注启动失败：" + r.error);
    if (r.started === 0) return say(r.message || "没有待预标注的文本");
    say(`已启动 LLM 批量预标注：${r.started} 条，完成后请在标注池逐条确认。`);
    tlPollVlm(true);
  } else if (action === "export_results") {
    const r = await api("/api/text_pool/export", { method: "POST" });
    if (r.ok) say(`已导出 ${r.confirmed} 条已确认结果：\n${r.excel}`);
    else say("导出失败：" + (r.error || "未知错误"));
  }
}

// ==================== VLM 状态与用户级模型配置 ====================
async function checkVlm() {
  const r = await api("/api/vlm/status");
  const dot = $("#vlm-status"), txt = $("#vlm-text");
  dot.classList.toggle("vlm-ok", r.ok);
  dot.classList.toggle("vlm-bad", !r.ok);
  txt.textContent = r.ok ? `⚙ ${r.model}` : "⚙ VLM 不可用";
  const title = (r.is_default ? "服务器默认" : "自定义配置") + " · " + r.endpoint
    + (r.error ? "\n" + r.error : "") + "\n点击更换模型（API 地址 / 模型名称 / Key）";
  dot.title = title;
  txt.title = title;
  return r;
}

// 模型设置弹窗（按昵称独立，各字段留空 = 使用服务器默认；支持拉取模型列表下拉选择）
async function openVlmModal() {
  // 先立即显示弹窗（状态区显示"检测中"），连通性探测放到后台异步刷新，避免 VLM 服务慢时长时间无响应
  $("#vlm-modal").style.display = "flex";
  $("#vlm-cfg-status").textContent = "检测中…";
  const cfg = await api("/api/vlm/config");
  if (cfg.error) { $("#vlm-cfg-status").textContent = cfg.error; return; }
  $("#inp-vlm-endpoint").value = cfg.endpoint || "";
  $("#inp-vlm-model").value = cfg.model || "";
  $("#inp-vlm-key").value = cfg.api_key || "";
  $("#vlm-models-msg").textContent = "";
  checkVlm().then(st => {
    $("#vlm-cfg-status").textContent = st
      ? `当前生效：${st.is_default ? "服务器默认" : "自定义配置"} · ${st.ok ? "服务在线" : "服务不可达"} · ${st.model}`
      : "";
  }).catch(() => { $("#vlm-cfg-status").textContent = ""; });
}

function closeVlmModal() { $("#vlm-modal").style.display = "none"; }
$("#btn-vlm-close").onclick = closeVlmModal;
// 点击遮罩空白处关闭
$("#vlm-modal").addEventListener("click", (e) => {
  if (e.target === $("#vlm-modal")) closeVlmModal();
});

$("#vlm-status").addEventListener("click", openVlmModal);
$("#vlm-text").addEventListener("click", openVlmModal);

// 按弹窗当前填写的 API 地址 / Key 拉取可用模型列表（保存前即可验证连通并选择模型名）
$("#btn-vlm-models").onclick = async () => {
  const btn = $("#btn-vlm-models"), msg = $("#vlm-models-msg");
  btn.disabled = true;
  msg.textContent = "正在获取模型列表…";
  const r = await api("/api/vlm/models", {
    method: "POST",
    body: { endpoint: $("#inp-vlm-endpoint").value.trim(),
            api_key: $("#inp-vlm-key").value.trim() },
  });
  btn.disabled = false;
  if (r.error) { msg.textContent = r.error; return; }
  if (!r.ok) { msg.textContent = "获取失败：" + (r.error || "未知错误"); return; }
  $("#vlm-model-list").innerHTML = (r.models || []).map(m =>
    `<option value="${esc(m)}">`).join("");
  msg.textContent = r.models.length
    ? `已获取 ${r.models.length} 个模型，点击「模型名称」输入框下拉选择`
    : "服务在线但未返回模型列表，请手动填写模型名称";
};

$("#btn-vlm-save").onclick = async () => {
  const body = {
    endpoint: $("#inp-vlm-endpoint").value.trim(),
    model: $("#inp-vlm-model").value.trim(),
    api_key: $("#inp-vlm-key").value.trim(),
  };
  const r = await api("/api/vlm/config", { method: "POST", body });
  if (r.error) { toast(r.error, false); return; }
  toast(r.reset ? "已恢复服务器默认配置" : "模型配置已保存（本昵称独立生效）");
  closeVlmModal();
  checkVlm();
};

$("#btn-vlm-reset").onclick = async () => {
  const r = await api("/api/vlm/config", { method: "POST", body: { endpoint: "", model: "", api_key: "" } });
  if (r.error) { toast(r.error, false); return; }
  $("#inp-vlm-endpoint").value = r.endpoint || "";
  $("#inp-vlm-model").value = r.model || "";
  $("#inp-vlm-key").value = "";
  toast("已恢复服务器默认配置");
  $("#vlm-cfg-status").textContent = "检测中…";
  checkVlm().then(st => {
    $("#vlm-cfg-status").textContent = st
      ? `当前生效：${st.is_default ? "服务器默认" : "自定义配置"} · ${st.ok ? "服务在线" : "服务不可达"} · ${st.model}`
      : "";
  }).catch(() => { $("#vlm-cfg-status").textContent = ""; });
};

// ==================== 项目（协作底座） ====================
function renderProjSelect(sess) {
  const sel = $("#proj-select");
  S.projects = sess.projects || [];
  S.projectId = sess.project_id || "";
  sel.innerHTML = S.projects.length
    ? S.projects.map((p) =>
        `<option value="${esc(p.id)}" ${p.id === S.projectId ? "selected" : ""}>📁 ${esc(p.name)}</option>`
      ).join("")
    : `<option value="">（无项目）</option>`;
}

async function afterProjectSwitch(probe, silent = false) {
  await resetViews();
  // 重置旧项目残留：总览页恢复按钮/提示、导入框预填路径
  $("#btn-dash-resume").style.display = "none";
  $("#dash-resume-info").style.display = "none";
  $("#inp-folder").value = "";
  if (probe) {
    await initData();
    if (!silent) toast("已切换项目并加载数据");
  } else {
    S.tree = null; S.probe = null;
    loadDashboard();     // 无数据源 → 显示空状态引导页
    if (!silent) toast("已切换项目（该项目尚未绑定数据源，请上传数据）");
  }
}

$("#proj-select").addEventListener("change", async () => {
  const pid = $("#proj-select").value;
  if (!pid || pid === S.projectId) return;
  toast("正在切换项目…");
  try {
    const r = await api(`/api/projects/${encodeURIComponent(pid)}/activate`, { method: "POST" });
    if (r.error) { toast(r.error, false); return; }
    S.projectId = pid;   // 同步前端状态，避免往返切换时被守卫短路
    await afterProjectSwitch(r.probe);
  } catch (e) {
    toast("切换失败：" + (e.message || e), false);
  }
});

$("#proj-new").onclick = () => {
  $("#inp-proj-name").value = "";
  $("#inp-proj-folder").value = "";
  $("#proj-modal").style.display = "flex";
};
$("#proj-cancel").onclick = () => ($("#proj-modal").style.display = "none");
$("#proj-create").onclick = async () => {
  const name = $("#inp-proj-name").value.trim();
  if (!name) { toast("请填写项目名称", false); return; }
  const source = $("#inp-proj-folder").value.trim();
  const btn = $("#proj-create");
  btn.disabled = true;
  try {
    const r = await api("/api/projects", { method: "POST", body: { name, source } });
    if (r.error) { toast(r.error, false); return; }
    S.projectId = r.id;  // 新建即激活
    renderProjSelect(await api("/api/session"));   // 刷新下拉框，新项目立即可见
    $("#proj-modal").style.display = "none";
    await afterProjectSwitch(r.probe, true);
    if (!r.probe) showImport();   // 未绑定数据源 → 直接进入导入流程
    toast(r.probe ? `项目「${name}」已创建并加载数据` : `项目「${name}」已创建`);
  } finally {
    btn.disabled = false;
  }
};

// 删除当前项目（含其标注记录与已上传数据，二次确认）
$("#proj-del").onclick = async () => {
  const proj = S.projects.find((p) => p.id === S.projectId);
  if (!proj) return toast("当前没有可删除的项目", false);
  if (!confirm(`确定删除项目「${proj.name}」吗？\n\n该项目的标注记录、框标注与已上传数据将被永久删除，不可恢复！`)) return;
  const r = await api(`/api/projects/${encodeURIComponent(proj.id)}/delete`, { method: "POST" });
  if (r.error) { toast(r.error, false); return; }
  toast(`已删除项目「${r.name || proj.name}」`);
  const sess = await api("/api/session");
  renderProjSelect(sess);
  if (!sess.project_id) {
    // 删除的是激活项目：回到空状态引导页
    await afterProjectSwitch(null, true);
  }
};

// ==================== 数据导入 ====================
async function initData() {
  S.tree = await api("/api/tree");
  const pr = await api("/api/probe");
  S.probe = pr.probe || null;
  loadDashboard();
  checkVlm();
}

async function resetViews() {
  S.tree = null; S.probe = null;   // 旧项目数据源状态一并清除（initData/afterProjectSwitch 会重填）
  S.rvQueue = []; S.rvIdx = -1;
  S.curDir = ""; S.gridOffset = 0; S.gridItems = [];
  S.txtTree = null; S.txtDir = "";
  if (S.tl.vlmTimer) { clearInterval(S.tl.vlmTimer); S.tl.vlmTimer = null; }
  if (S.batchTimer) { clearInterval(S.batchTimer); S.batchTimer = null; }
  CHAT.image = { msgs: [], busy: false, greeted: false };
  CHAT.text = { msgs: [], busy: false, greeted: false };
  $("#img-grid").innerHTML = "";
  $("#dir-stats").textContent = "";
  $("#cur-dir").textContent = "未选择目录";
  $("#rv-list").innerHTML = "";
  $("#rv-detail").innerHTML = `<div class="rv-empty">左侧选择图片开始复核</div>`;
  $("#rv-counts").innerHTML = "";
  $("#label-tree").innerHTML = "";
  $("#txt-tree").innerHTML = "";
  $("#txt-lines").innerHTML = "";
  $("#tl-list").innerHTML = "";
  $("#editor-modal").style.display = "none";
}

async function enterPlatform() {
  $("#import-screen").style.display = "none";
  await resetViews();
  await initData();
  toast("数据已加载，可在「图片 / 文本」开始工作");
}

// 读取上次会话（后端已有数据，跳过重新解析）
async function resumeSession() {
  const btn = $("#btn-dash-resume");
  if (btn.disabled) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "⏳ 读取中…";
  toast("正在读取上次会话数据，大目录约需十几秒…");
  try {
    // 服务重启后内存态丢失：先按持久化路径重新解析，再加载视图
    const sess = await api("/api/session");
    if (!sess.folder) throw new Error("没有可恢复的会话");
    if (!sess.loaded) {
      const r = await api("/api/load", { method: "POST", body: { folder: sess.folder } });
      if (r.error) throw new Error(r.error);
    }
    await resetViews();
    await initData();
    toast("已读取上次会话数据");
  } catch (e) {
    toast("读取失败：" + (e.message || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function showImport() {
  $("#import-screen").style.display = "flex";
  $("#btn-import-cancel").style.display = "";
  // 上传任务在后台继续跑：重开弹窗按阶段恢复视图，绝不重置进行中的状态
  if (UP.phase === "uploading") { restoreUploadView(); return; }
  if (UP.phase === "done") { restoreUploadView(); $("#upload-progress").style.display = "none"; $("#probe-box").style.display = ""; return; }
  uploadResetUI();
  showImpTab("upload");
}

$("#btn-data").onclick = () => showImport();
$("#btn-dash-upload").onclick = () => showImport();
// 总览入口卡：点击直达对应功能页
$("#da-annotate").onclick = () => nav("image");
$("#da-vlm").onclick = () => { nav("image"); toast("已进入图片页，左上角「🤖 批量预标注」可发起"); };
$("#da-review").onclick = () => { nav("image"); setImgMode("review"); };
$("#da-text").onclick = () => nav("text");
$("#btn-dash-resume").onclick = resumeSession;
$("#btn-import-cancel").onclick = () => ($("#import-screen").style.display = "none");

// ---------- 导入方式 tab 切换（本地上传 / 服务器路径） ----------
function showImpTab(name) {
  $$("#import-screen .imp-tab").forEach((t) => t.classList.toggle("active", t.dataset.impTab === name));
  $("#imp-upload").style.display = name === "upload" ? "" : "none";
  $("#imp-path").style.display = name === "path" ? "" : "none";
}
$$("#import-screen .imp-tab").forEach((t) => (t.onclick = () => showImpTab(t.dataset.impTab)));

$("#btn-load").onclick = async () => {
  const folder = $("#inp-folder").value.trim();
  if (!folder) { toast("请填写或选择数据文件夹", false); return; }
  const box = $("#probe-box"), rep = $("#probe-report-import"), go = $("#btn-probe-go");
  box.style.display = "none"; go.style.display = "none";
  $("#btn-load").disabled = true;
  try {
    const r = await api("/api/load", { method: "POST", body: { folder } });
    if (!r.ok) { toast(r.error || "解析失败", false); return; }
    box.style.display = "";
    rep.innerHTML = renderProbeReport(r.probe);
    go.onclick = enterPlatform;
    go.style.display = "";
    toast("文件夹解析完成，请确认探测报告");
  } finally { $("#btn-load").disabled = false; }
};

// ---------- 本地上传（浏览器直传文件夹 / zip → /api/upload/*） ----------
// phase: idle=未开始/失败 | uploading=上传中（关弹窗后台继续） | done=已传完待确认解析报告
const UP = { kind: "", files: [], zip: null, sid: "", xhr: null, aborted: false, phase: "idle" };

function uploadResetUI() {
  UP.kind = ""; UP.files = []; UP.zip = null; UP.sid = ""; UP.xhr = null; UP.aborted = false; UP.phase = "idle";
  $("#upload-pick").style.display = "";
  $("#upload-form").style.display = "none";
  $("#upload-progress").style.display = "none";
  $("#probe-box").style.display = "none";
  $("#upload-msg").textContent = "";
  $("#btn-upload-start").disabled = false;
}

function restoreUploadView() {
  showImpTab("upload");
  $("#upload-pick").style.display = "none";
  $("#upload-form").style.display = "none";
  $("#upload-progress").style.display = "";
  $("#probe-box").style.display = "none";
}

function showUploadMsg(msg) {
  // 失败终态：释放服务端会话与暂存目录（cancel 幂等，finish 已消费会话时无害）
  if (UP.sid) {
    const sid = UP.sid;
    UP.sid = "";
    api(`/api/upload/cancel?sid=${encodeURIComponent(sid)}`, { method: "POST" });
  }
  UP.phase = "idle";
  $("#upload-progress").style.display = "none";
  $("#upload-form").style.display = "";
  $("#upload-msg").textContent = msg;
}

$("#btn-pick-folder").onclick = () => $("#inp-dir-files").click();
$("#btn-pick-zip").onclick = () => $("#inp-zip-file").click();

$("#inp-dir-files").onchange = (e) => {
  const fs = [...e.target.files];
  e.target.value = "";
  if (!fs.length) return;
  // 过滤系统杂项文件（macOS / Windows 资源文件；._* 为 mac AppleDouble 资源文件）
  const junk = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]+)(\/|$)/i;
  UP.kind = "folder";
  UP.files = fs.filter((f) => !junk.test(f.webkitRelativePath || f.name))
    .map((f) => ({ f, rel: f.webkitRelativePath || f.name }));
  if (!UP.files.length) { toast("所选文件夹没有可用文件", false); return; }
  const bytes = UP.files.reduce((s, x) => s + x.f.size, 0);
  // webkitRelativePath 首段 = 所选文件夹名，作为默认数据集名
  const root = UP.files[0].rel.split("/")[0] || "本地数据";
  prepareUpload(root, `${UP.files.length} 个文件`, bytes);
};

$("#inp-zip-file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  UP.kind = "zip"; UP.files = []; UP.zip = f;
  prepareUpload(f.name.replace(/\.zip$/i, ""), "zip 压缩包", f.size);
};

function prepareUpload(name, desc, bytes) {
  $("#upload-pick").style.display = "none";
  $("#upload-form").style.display = "";
  $("#upload-msg").textContent = "";
  $("#inp-upload-name").value = name;
  $("#upload-summary").textContent = `${desc}，共 ${fmtSize(bytes)}`;
}

$("#btn-upload-reset").onclick = () => {
  $("#upload-pick").style.display = "";
  $("#upload-form").style.display = "none";
  $("#upload-msg").textContent = "";
};

// 带 X-User 头 + 上传进度的 XHR（api() 封装不含进度事件）
function uploadXhr(url, blob, onprog) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.responseType = "json";
    x.setRequestHeader("X-User", encodeURIComponent(S.user || ""));
    if (onprog) x.upload.onprogress = (e) => onprog(e.loaded, e.total);
    x.onload = () => resolve(x.response || { error: "HTTP " + x.status });
    x.onerror = () => reject(new Error("网络错误"));
    x.send(blob);
    UP.xhr = x;
  });
}

function uploadBar(done, total, bytes) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#prog-fill").style.width = pct + "%";
  $("#prog-pct").textContent = pct + "%";
  $("#prog-label").textContent = `已上传 ${done}/${total}（${fmtSize(bytes)}）`;
}

$("#btn-upload-start").onclick = async () => {
  // 与 api() 同规则：未设置昵称先引导（写操作）
  if (!S.user && !(await ensureUser(true))) return;
  const name = $("#inp-upload-name").value.trim() || "uploaded_data";
  $("#btn-upload-start").disabled = true;
  $("#upload-msg").textContent = "";
  try {
    const b = await api("/api/upload/begin", { method: "POST", body: { kind: UP.kind, name } });
    if (b.error || !b.ok) { toast(b.error || "创建上传会话失败", false); return; }
    UP.sid = b.sid; UP.aborted = false;
    $("#upload-form").style.display = "none";
    $("#upload-progress").style.display = "";
    uploadBar(0, 1, 0);
    if (UP.kind === "zip") await uploadZipFile();
    else await uploadAllFiles();
  } catch (e) {
    showUploadMsg("上传失败：" + (e.message || e));
  } finally {
    $("#btn-upload-start").disabled = false;
  }
};

async function uploadAllFiles() {
  const items = UP.files, total = items.length;
  let done = 0, bytes = 0, idx = 0, failed = [];
  const CONC = 4;                       // 并发 4：单文件请求小，靠并发提速
  const worker = async () => {
    while (idx < total && !UP.aborted) {
      const it = items[idx++];
      for (let attempt = 0; attempt < 2 && !UP.aborted; attempt++) {
        try {
          const url = `/api/upload/file?sid=${encodeURIComponent(UP.sid)}&relpath=${encodeURIComponent(it.rel)}`;
          const r = await uploadXhr(url, it.f);
          if (r.error) throw new Error(r.error);
          done++; bytes += it.f.size;
          uploadBar(done, total, bytes);
          break;
        } catch (e) {
          if (UP.aborted) return;
          if (attempt === 1) failed.push(it.rel);   // 重试一次仍失败
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  if (UP.aborted) return;
  if (failed.length) {
    showUploadMsg(`${failed.length} 个文件上传失败（如 ${failed[0]}），请重试`);
    return;
  }
  await finishUpload(total);
}

async function uploadZipFile() {
  const f = UP.zip;
  const r = await uploadXhr(
    `/api/upload/file?sid=${encodeURIComponent(UP.sid)}&relpath=${encodeURIComponent(f.name)}`, f,
    (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      $("#prog-fill").style.width = pct + "%";
      $("#prog-pct").textContent = pct + "%";
      $("#prog-label").textContent = `正在上传 ${f.name}（${fmtSize(loaded)} / ${fmtSize(total)}）`;
    });
  if (UP.aborted) return;
  if (r.error) { showUploadMsg("zip 上传失败：" + r.error); return; }
  await finishUpload(1);
}

async function finishUpload(n) {
  $("#prog-fill").style.width = "100%";
  $("#prog-pct").textContent = "100%";
  $("#prog-label").textContent = "上传完成，服务端解析中（大目录约需十几秒）…";
  const r = await api(`/api/upload/finish?sid=${encodeURIComponent(UP.sid)}`, { method: "POST" });
  if (r.error) { showUploadMsg("解析失败：" + r.error); return; }
  UP.sid = "";
  UP.phase = "done";                               // 弹窗被关闭时重开仍能看到解析报告
  $("#upload-progress").style.display = "none";
  $("#probe-box").style.display = "";
  $("#probe-report-import").innerHTML = renderProbeReport(r.probe);
  $("#btn-probe-go").onclick = enterPlatform;
  $("#btn-probe-go").style.display = "";
  toast(`上传完成（${n} 个文件），请确认解析报告`);
}

$("#btn-upload-cancel").onclick = async () => {
  UP.aborted = true;
  if (UP.xhr) { try { UP.xhr.abort(); } catch (e) { /* 忽略 */ } }
  if (UP.sid) await api(`/api/upload/cancel?sid=${encodeURIComponent(UP.sid)}`, { method: "POST" });
  uploadResetUI();
  toast("已取消上传");
};

// ---------- 本地目录浏览 ----------
let fsTarget = null, fsCur = "";

function fsNav(path) {
  api(`/api/fs/dirs?path=${encodeURIComponent(path)}`).then((r) => {
    if (r.error) { toast(r.error, false); return; }
    fsCur = r.path;
    $("#fs-path").textContent = r.path || "（选择磁盘）";
    $("#fs-pick").style.display = r.path ? "" : "none";
    $("#fs-list").innerHTML = r.dirs.map((d) => {
      const name = d.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      return `<div class="fs-item" data-p="${esc(d)}">📁 ${esc(name)}</div>`;
    }).join("") || '<div class="muted" style="padding:12px">（无子目录）</div>';
    $$("#fs-list .fs-item").forEach((el) => (el.onclick = () => fsNav(el.dataset.p)));
  });
}

$$("[data-browse]").forEach((btn) => {
  btn.onclick = () => { fsTarget = document.getElementById(btn.dataset.browse); fsModalShow(); };
});
function fsModalShow() { $("#fs-modal").style.display = "flex"; fsNav(""); }
$("#fs-close").onclick = () => ($("#fs-modal").style.display = "none");
$("#fs-up").onclick = () => {
  api(`/api/fs/dirs?path=${encodeURIComponent(fsCur)}`).then((r) => {
    if (r && r.parent !== undefined) fsNav(r.parent);
  });
};
$("#fs-pick").onclick = () => {
  if (fsTarget) fsTarget.value = fsCur;
  $("#fs-modal").style.display = "none";
};

// ==================== 标签集列表编辑（配置弹窗 + 独立标注页共用） ====================
// 行结构 .le-row[data-i] > .le-drag + .le-name + .le-x：拖动排序 / 双击重命名 / × 删除
function wireLabelRows(wrap, arr, rerender) {
  let dragIdx = -1;
  wrap.querySelectorAll(".le-row").forEach((row) => {
    const i = +row.dataset.i;
    row.addEventListener("dragstart", (e) => {
      dragIdx = i;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(i)); } catch (_) { /* IE 兼容，可忽略 */ }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      wrap.querySelectorAll(".le-row").forEach((r) => r.classList.remove("drag-over"));
      dragIdx = -1;
    });
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (dragIdx < 0 || dragIdx === i) return;
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(i, 0, moved);
      rerender();
    });
    row.querySelector(".le-name").addEventListener("dblclick", () => {
      const nl = prompt("修改标签：", arr[i]);
      if (nl === null) return;
      const v = nl.trim();
      if (!v) return toast("标签不能为空", false);
      if (v !== arr[i] && arr.includes(v)) return toast("标签已存在：" + v, false);
      arr[i] = v;
      rerender();
    });
    row.querySelector(".le-x").addEventListener("click", () => {
      arr.splice(i, 1);
      rerender();
    });
  });
}

function labelRowsHtml(labels, imported) {
  const imp = imported || [];
  return labels.map((l, i) => `
    <div class="le-row" draggable="true" data-i="${i}">
      <span class="le-drag" title="拖动排序">⠿</span>
      <span class="le-name" title="双击修改">${esc(l)}</span>
      <span class="le-src ${imp.includes(l) ? "imp" : "man"}" title="${imp.includes(l) ? "数据导入" : "手动创建"}">${imp.includes(l) ? "导入" : "手动"}</span>
      <span class="le-x" title="删除">×</span>
    </div>`).join("");
}

// ---------- 配置弹窗标签集工作副本（打开时回填上次保存值，支持修正） ----------
const CFG_LABELS = { list: [], imported: [] };

function renderCfgLabels() {
  const wrap = $("#cfg-label-list");
  wrap.innerHTML = CFG_LABELS.list.length
    ? labelRowsHtml(CFG_LABELS.list, CFG_LABELS.imported)
    : `<span class="muted" style="padding:6px 2px">尚未配置标签：在下方输入，或点按钮导入</span>`;
  $("#cfg-labels-count").textContent = CFG_LABELS.list.length ? `共 ${CFG_LABELS.list.length} 个` : "";
  wireLabelRows(wrap, CFG_LABELS.list, renderCfgLabels);
}

function cfgLabelAdd() {
  const inp = $("#cfg-label-new");
  const lines = [...new Set(inp.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  if (!lines.length) return;
  let dup = 0;
  for (const l of lines) {
    if (CFG_LABELS.list.includes(l)) { dup++; continue; }
    CFG_LABELS.list.push(l);
  }
  inp.value = "";
  renderCfgLabels();
  if (dup) toast(`${dup} 个重复标签已跳过`);
}
$("#cfg-label-add").onclick = cfgLabelAdd;
$("#cfg-label-new").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); cfgLabelAdd(); }
});
$("#cfg-labels-clear").onclick = () => { CFG_LABELS.list = []; renderCfgLabels(); };

// ==================== 独立标注页（配置后进入手工标注） ====================
const ANNO = {
  line: "image", taskType: "classify", format: "txt",
  start: 1, group: 50, labels: [], imported: [],
  queue: [], qi: 0, offset: 0, total: 0,
  editor: null,
  _saving: false,        // 检测模式保存进行中标志（双击防重入）
  imgZoom: 1,          // 分类模式大图缩放倍数（1=适应窗口）
  labelsExpanded: false,   // 标签列表展开态（过多时默认收起）
  // 标签在线编辑（确认后覆盖保存）
  labelEdit: false, editLabels: [],
};

// 从目录树收集真实类别名：跳过含数字的统计性目录（如"1.6万张"、"涉政5000张"），下钻取其子类别
function collectCategoryNames() {
  const out = [];
  const seen = new Set();
  (function walk(nodes) {
    (nodes || []).forEach(n => {
      if (/\d/.test(n.name)) {
        if (n.children && n.children.length) walk(n.children);
      } else if (!seen.has(n.name)) {
        seen.add(n.name);
        out.push(n.name);
      }
    });
  })(S.tree.children || []);
  return out;
}

async function openAnnoConfig(line) {
  ANNO.line = line;
  const isImg = line === "image";
  $("#cfg-task-type-row").style.display = isImg ? "" : "none";
  // 文本线固定分类任务，格式只有 txt/csv
  const fmt = $("#cfg-format");
  [...fmt.options].forEach(o => {
    const detectOnly = ["yolo", "coco"].includes(o.value);
    o.style.display = (!isImg && detectOnly) ? "none" : "";
  });
  if (!isImg) {
    fmt.value = "txt";
    document.querySelector('input[name="cfg-task-type"][value="classify"]').checked = true;
  }
  // 标签集回填上次保存值（列表化编辑，支持修正）；其余字段回填逻辑不变
  const saved = await api("/api/annotate/config");
  const cfg = (saved && saved.config) || {};
  if (cfg.line === line) {
    if (cfg.format && [...fmt.options].some(o => o.value === cfg.format && o.style.display !== "none")) {
      fmt.value = cfg.format;
    }
    if (isImg && cfg.task_type) {
      const r = document.querySelector(`input[name="cfg-task-type"][value="${cfg.task_type}"]`);
      if (r) r.checked = true;
    }
    if (cfg.start) $("#cfg-start").value = cfg.start;
    if (cfg.group) $("#cfg-group").value = cfg.group;
  }
  CFG_LABELS.list = (cfg.line === line && Array.isArray(cfg.labels)) ? [...cfg.labels] : [];
  CFG_LABELS.imported = (cfg.line === line && Array.isArray(cfg.imported_labels))
    ? cfg.imported_labels.filter(l => CFG_LABELS.list.includes(l)) : [];
  renderCfgLabels();
  $("#anno-config-modal").style.display = "flex";
}
$("#btn-start-anno").onclick = () => openAnnoConfig("image");
$("#btn-start-anno-text").onclick = () => openAnnoConfig("text");
$("#cfg-cancel").onclick = () => ($("#anno-config-modal").style.display = "none");

// 类型 -> 格式联动
document.querySelectorAll('input[name="cfg-task-type"]').forEach(r =>
  r.addEventListener("change", () => {
    const fmt = $("#cfg-format");
    fmt.value = r.value === "detect" ? "yolo" : "txt";
  }));

$("#cfg-labels-en").onclick = () => {
  CFG_LABELS.list = EN_LABELS.slice(0, 20);
  renderCfgLabels();
};
$("#cfg-labels-dirs").onclick = () => {
  if (!S.tree || !S.tree.children.length) return toast("目录树未加载", false);
  CFG_LABELS.list = collectCategoryNames();
  renderCfgLabels();
};

async function annoLoadQueue() {
  if (ANNO.line === "image") {
    const r = await api(`/api/label/images?dir=&offset=${ANNO.offset}&limit=${ANNO.group}`);
    if (r.error) return toast(r.error, false);
    ANNO.queue = r.items;
    ANNO.total = r.total;
  } else {
    const r = await api(`/api/text_pool/list?status=all&q=`);
    if (r.error) return toast(r.error, false);
    ANNO.total = r.items.length;
    ANNO.queue = r.items.slice(ANNO.offset, ANNO.offset + ANNO.group);
  }
}

async function enterAnno() {
  const labels = [...new Set(CFG_LABELS.list.filter(Boolean))];
  if (!labels.length) return toast("请先配置标签集（至少一个标签）", false);
  const isImg = ANNO.line === "image";
  ANNO.taskType = isImg
    ? (document.querySelector('input[name="cfg-task-type"]:checked') || {}).value || "classify"
    : "classify";
  ANNO.format = $("#cfg-format").value;
  ANNO.start = Math.max(1, parseInt($("#cfg-start").value) || 1);
  ANNO.group = Math.max(1, parseInt($("#cfg-group").value) || 50);
  ANNO.labels = labels;
  ANNO.imported = [...new Set(CFG_LABELS.imported.filter(l => labels.includes(l)))];
  ANNO.offset = ANNO.start - 1;
  ANNO.qi = 0;
  ANNO.labelEdit = false;      // 进入标注页重置标签编辑态
  ANNO.labelsExpanded = false; // 进入标注页标签列表重置为收起
  ANNO.editLabels = [];
  updateAnnoLabelEditBar();

  await api("/api/annotate/config", {
    method: "POST",
    body: { line: ANNO.line, task_type: ANNO.taskType, format: ANNO.format,
            start: ANNO.start, group: ANNO.group, labels: ANNO.labels },
  });

  await annoLoadQueue();
  if (!ANNO.queue.length) return toast("该起标点之后没有待标注内容", false);

  // 进入独立标注页（隐藏顶栏，全屏）
  $("#anno-config-modal").style.display = "none";
  document.body.classList.add("anno-full");
  $$(".tab").forEach(b => b.classList.remove("active"));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-annotate"));
  $("#anno-pane-image").style.display = isImg ? "flex" : "none";
  $("#anno-pane-text").style.display = isImg ? "none" : "flex";
  $("#anno-task").textContent = isImg
    ? `图片${ANNO.taskType === "detect" ? "检测" : "分类"} · ${ANNO.format.toUpperCase()} · ${ANNO.labels.length} 个标签`
    : `文本分类 · ${ANNO.format.toUpperCase()} · ${ANNO.labels.length} 个标签`;

  if (isImg && ANNO.taskType === "detect") {
    if (!ANNO.editor) {
      ANNO.editor = new BoxEditor($("#anno-canvas"), $("#anno-canvas-wrap"),
        () => $("#anno-box-label").value);
      ANNO.editor.onChange = () => renderAnnoBoxList();
    }
    ANNO.editor.setTool(["point", "line"].find(t => $(`#anno-tool-${t}`).classList.contains("active")) || "box");
  }
  renderAnnoLabels();
  annoShow(0);
  toast("已进入标注页，快捷键：1-9 选标签，←→ 翻页");
}

function renderAnnoLabels() {
  const grid = ANNO.line === "image" ? $("#anno-label-grid") : $("#anno-tlabel-grid");
  // 编辑态：标签行可拖动排序 / 双击重命名 / × 删除，尾部「＋ 添加标签」
  if (ANNO.labelEdit) {
    grid.innerHTML = labelRowsHtml(ANNO.editLabels, ANNO.imported);
    const add = document.createElement("button");
    add.className = "lg-btn lg-add";
    add.textContent = "＋ 添加标签";
    add.onclick = () => {
      const nl = prompt("新标签：");
      if (nl === null) return;
      const v = nl.trim();
      if (!v) return toast("标签不能为空", false);
      if (ANNO.editLabels.includes(v)) return toast("标签已存在：" + v, false);
      ANNO.editLabels.push(v);
      renderAnnoLabels();
    };
    grid.appendChild(add);
    wireLabelRows(grid, ANNO.editLabels, renderAnnoLabels);
    return;
  }
  grid.innerHTML = ANNO.labels.map((l, i) => `
    <button class="lg-btn" data-l="${esc(l)}">
      <span class="lg-key">${i < 9 ? i + 1 : ""}</span>${esc(l)}<span class="lg-src ${ANNO.imported.includes(l) ? "imp" : "man"}" title="${ANNO.imported.includes(l) ? "数据导入" : "手动创建"}">${ANNO.imported.includes(l) ? "导" : "手"}</span>
    </button>`).join("");
  const isDetect = ANNO.line === "image" && ANNO.taskType === "detect";
  grid.querySelectorAll(".lg-btn").forEach(b =>
    b.addEventListener("click", () => {
      if (isDetect) {
        // 检测模式：点标签 = 切换当前绘制标签；有选中形状时直接改其标签（不写分类标注）
        const lbl = b.dataset.l;
        $("#anno-box-label").value = lbl;
        if (ANNO.editor && ANNO.editor.selected >= 0 && ANNO.editor.shapes[ANNO.editor.selected]) {
          ANNO.editor.shapes[ANNO.editor.selected].label = lbl;
          ANNO.editor.draw();
          renderAnnoBoxList();
        }
        syncAnnoLabelActive();
      } else {
        annoPickLabel(b.dataset.l);
      }
    }));
  // 标签过多时收起：默认只显示前 10 个，避免侧栏过长把检测面板/导航按钮推到屏幕外
  appendLabelToggle(grid, ANNO.labels.length, 10, ANNO.labelsExpanded,
    () => { ANNO.labelsExpanded = !ANNO.labelsExpanded; renderAnnoLabels(); });
  if (isDetect) {
    // 框标签下拉与标签集同步（尽量保留已选值）
    const sel = $("#anno-box-label"), prev = sel.value;
    sel.innerHTML = ANNO.labels.map(l =>
      `<option value="${esc(l)}">${esc(l)}</option>`).join("");
    sel.value = ANNO.labels.includes(prev) ? prev : (ANNO.labels[0] || "");
    syncAnnoLabelActive();
  }
}

// 标签过多时收起：total <= n 不处理；未展开隐藏第 n 个之后的按钮，并追加「展开全部 / 收起」
function appendLabelToggle(grid, total, n, expanded, toggle) {
  if (total <= n) return;
  if (!expanded) {
    grid.querySelectorAll(".lg-btn").forEach((b, i) => {
      if (i >= n) b.style.display = "none";
    });
  }
  const t = document.createElement("button");
  t.className = "lg-btn lg-toggle";
  t.textContent = expanded ? "收起 ▴" : `展开全部（共 ${total} 个）▾`;
  t.onclick = toggle;
  grid.appendChild(t);
}

// 收起状态下激活标签被隐藏时自动展开（展开会重渲染丢失 active，需补回）
function ensureActiveLabelVisible(sel) {
  const grid = document.querySelector(sel);
  if (!grid) return;
  const act = grid.querySelector(".lg-btn.active");
  if (!act || act.style.display !== "none") return;
  const lbl = act.dataset.l;
  const t = grid.querySelector(".lg-toggle");
  if (t) t.click();   // 展开并重渲染
  const again = grid.querySelector(`.lg-btn[data-l="${CSS.escape(lbl)}"]`);
  if (again) again.classList.add("active");
}

// 检测模式：高亮当前框标签对应的标签按钮
function syncAnnoLabelActive() {
  const cur = $("#anno-box-label") ? $("#anno-box-label").value : "";
  $$("#anno-label-grid .lg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.l === cur));
  ensureActiveLabelVisible("#anno-label-grid");
}

// 标注页工具切换：画框 / 点标注（会话内保持，换图/换组不重置）
const ANNO_HINTS = {
  box: "拖动画框 · 单击框内选中（选中后整体拖动）· 拖角点调大小 · 双击框内改标签 · N 键锚定起点拉框（再按 N 取消）· Delete 删除 · 滚轮缩放",
  point: "单击画布加点 · 拖动微调 · 双击改标签 · Delete 删除 · 滚轮缩放 · 选中后点标签改标签",
  line: "点一下定起点 · 移动鼠标预览直线 · 再点一下定终点成线 · 点线选中（整体拖动/拖端点调整）· 双击改标签 · Esc 取消 · Delete 删除",
};
function setAnnoTool(t) {
  $("#anno-tool-box").classList.toggle("active", t === "box");
  $("#anno-tool-point").classList.toggle("active", t === "point");
  $("#anno-tool-line").classList.toggle("active", t === "line");
  $("#anno-tool-hint").textContent = ANNO_HINTS[t];
  if (ANNO.editor) ANNO.editor.setTool(t);
}
$("#anno-tool-box").addEventListener("click", () => setAnnoTool("box"));
$("#anno-tool-point").addEventListener("click", () => setAnnoTool("point"));
$("#anno-tool-line").addEventListener("click", () => setAnnoTool("line"));
// 下拉切换当前标签：有选中形状时同步改其标签
$("#anno-box-label").addEventListener("change", () => {
  if (ANNO.editor && ANNO.editor.selected >= 0 && ANNO.editor.shapes[ANNO.editor.selected]) {
    ANNO.editor.shapes[ANNO.editor.selected].label = $("#anno-box-label").value;
    ANNO.editor.draw();
    renderAnnoBoxList();
  }
});

// ---------- 标签在线编辑（导入标签后仍可调整：拖动 / 改名 / 删除 / 新增） ----------
function updateAnnoLabelEditBar() {
  ["anno-label", "anno-tlabel"].forEach((p) => {
    const t = $(`#${p}-edit`), bar = $(`#${p}-bar`);
    if (t) t.style.display = ANNO.labelEdit ? "none" : "";
    if (bar) bar.style.display = ANNO.labelEdit ? "" : "none";
  });
}

function setAnnoLabelEdit(on) {
  if (on === ANNO.labelEdit) { updateAnnoLabelEditBar(); return; }
  ANNO.labelEdit = on;
  if (on) ANNO.editLabels = [...ANNO.labels];   // 编辑副本，确认前不动原标签
  updateAnnoLabelEditBar();
  renderAnnoLabels();
}

async function saveAnnoLabels() {
  const labels = [...new Set(ANNO.editLabels.filter(Boolean))];
  if (!labels.length) return toast("标签集不能为空", false);
  // 确认后：编辑缓存覆盖原标签（持久化到 annotate_cfg.labels）
  const r = await api("/api/annotate/config", {
    method: "POST",
    body: { line: ANNO.line, task_type: ANNO.taskType, format: ANNO.format,
            start: ANNO.start, group: ANNO.group, labels },
  });
  if (r.error) return toast(r.error || "保存失败", false);
  ANNO.labels = labels;
  ANNO.imported = (r.config && r.config.imported_labels) || [];   // 保存后同步标签来源
  ANNO.labelEdit = false;
  updateAnnoLabelEditBar();
  renderAnnoLabels();
  toast(`标签集已覆盖保存（${labels.length} 个，快捷键按新顺序生效）`);
  loadEditorLabels(true);   // 同步图片页编辑器弹层的标签副本
}

["anno-label", "anno-tlabel"].forEach((p) => {
  $(`#${p}-edit`).onclick = () => setAnnoLabelEdit(true);
  $(`#${p}-save`).onclick = saveAnnoLabels;
  $(`#${p}-cancel`).onclick = () => setAnnoLabelEdit(false);
});

// 分类模式大图：滚轮缩放（以适应窗口为 1x，最大 12x），双击复位
function wireAnnoImgZoom(im) {
  im.addEventListener("wheel", (e) => {
    if (!im.naturalWidth) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const z = Math.min(Math.max((ANNO.imgZoom || 1) * f, 1), 12);
    if (z === (ANNO.imgZoom || 1)) return;
    ANNO.imgZoom = z;
    applyAnnoImgZoom(im);
  }, { passive: false });
  im.addEventListener("dblclick", () => {
    ANNO.imgZoom = 1;
    applyAnnoImgZoom(im);
  });
}

function applyAnnoImgZoom(im) {
  const z = ANNO.imgZoom || 1;
  if (z === 1) {
    im.style.width = ""; im.style.height = "";
    im.style.maxWidth = "100%"; im.style.maxHeight = "100%";
    return;
  }
  im.style.maxWidth = "none"; im.style.maxHeight = "none";
  const w = parseFloat(im.dataset.w) || im.clientWidth || im.naturalWidth;
  const h = parseFloat(im.dataset.h) || im.clientHeight || im.naturalHeight;
  im.style.width = Math.round(w * z) + "px";
  im.style.height = Math.round(h * z) + "px";
}

// 窗口尺寸变化后重记 1x 基准（适应状态下 clientWidth 即新基准；缩放中由换图/双击复位自愈）
window.addEventListener("resize", () => {
  const im = $("#anno-img");
  if (!im || !im.naturalWidth || (ANNO.imgZoom || 1) !== 1) return;
  im.dataset.w = im.clientWidth;
  im.dataset.h = im.clientHeight;
});

async function annoShow(i) {
  ANNO.qi = Math.max(0, Math.min(i, ANNO.queue.length - 1));
  const qiAtEntry = ANNO.qi;      // 并发守卫：await 后游标已变说明翻到了别的图，本次渲染过期
  const it = ANNO.queue[ANNO.qi];
  if (!it) return;

  const groupNo = Math.floor(ANNO.offset / ANNO.group) + 1;
  const groupTotal = Math.max(1, Math.ceil(ANNO.total / ANNO.group));
  $("#anno-progress").textContent =
    `第 ${ANNO.offset + ANNO.qi + 1} / ${ANNO.total} ${ANNO.line === "image" ? "张" : "条"}`;
  $("#anno-group-info").textContent = `组 ${groupNo} / ${groupTotal}`;

  if (ANNO.line === "image") {
    const isCls = ANNO.taskType === "classify";
    // 标签列表分类/检测共用：只切换标题/提示与检测附加面板
    $("#anno-label-title").textContent = isCls ? "选择分类标签" : "框标签列表";
    $("#anno-label-hint").textContent = isCls
      ? "点击标签即保存并跳到下一张（快捷键 1-9）"
      : "点击标签切换画框使用的标签（快捷键 1-9）";
    $("#anno-detect-panel").style.display = isCls ? "none" : "";
    $("#anno-meta").textContent =
      `${it.image}${it.classified ? " · 已标：" + it.classified : ""}${it.classify_by ? " · 标注人：" + it.classify_by : ""}${it.has_boxes ? " · 有框" : ""}`;

    // AI 预标注提示：显眼展示已有标注结果；点 × 可取消（仅分类模式）
    const pre = $("#anno-pre-hint");
    pre.style.display = (isCls && it.classified) ? "" : "none";
    pre.innerHTML = (isCls && it.classified)
      ? `<span class="pre-tag">🤖 AI 预标注</span><span class="pre-path" title="${esc(it.classified)}">${esc(it.classified)}</span><button class="pre-clear" title="取消该图的预标注">×</button>`
      : "";
    if (isCls && it.classified) {
      pre.querySelector(".pre-clear").onclick = async () => {
        const r = await api("/api/classify", { method: "POST", body: { image: it.image, label_path: "" } });
        if (!r.ok) return toast(r.error || "清除失败", false);
        it.classified = "";
        toast("已取消该图的预标注");
        annoShow(ANNO.qi);
      };
    }

    if (isCls) {
      // 分类：显示大图（保留 canvas 节点，仅切换显示）
      let im = $("#anno-img");
      if (!im) {
        im = document.createElement("img");
        im.id = "anno-img";
        im.style.maxWidth = "100%";
        im.style.maxHeight = "100%";
        im.style.objectFit = "contain";
        wireAnnoImgZoom(im);
        $("#anno-canvas-wrap").appendChild(im);
      }
      // 换图重置缩放；加载后记录适应窗口的基准尺寸（缩放以它为 1x）
      ANNO.imgZoom = 1;
      im.style.width = ""; im.style.height = "";
      im.style.maxWidth = "100%"; im.style.maxHeight = "100%";
      const fitSize = () => { im.dataset.w = im.clientWidth; im.dataset.h = im.clientHeight; };
      im.onload = fitSize;
      im.src = imgUrl(it.image);
      if (im.complete && im.naturalWidth) fitSize();
      im.style.display = "";
      $("#anno-canvas").style.display = "none";
      // 回显已有标注（AI 预标注 / 手工已标）
      $$("#anno-label-grid .lg-btn").forEach(b =>
        b.classList.toggle("active", it.classified === b.dataset.l));
      ensureActiveLabelVisible("#anno-label-grid");
    } else {
      const im = $("#anno-img");
      if (im) im.style.display = "none";
      $("#anno-canvas").style.display = "";
      if (ANNO.editor) ANNO.editor.rel = "";   // 加载中：保存守卫拒发（防新图 it + 旧图 shapes 串图）
      const img = new Image();
      img.src = imgUrl(it.image);
      let loaded = true;
      try {
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      } catch { loaded = false; }
      if (ANNO.qi !== qiAtEntry) return;       // 过期渲染：丢弃，避免旧图覆盖新图编辑器
      if (!loaded) {                           // 加载失败：提示并保持拒发守卫（rel 为空）
        toast(`图片加载失败：${it.image}`, false);
        return;
      }
      ANNO.editor.setImage(img, 130);
      const boxes = await api(`/api/boxes?image=${encodeURIComponent(it.image)}`);
      if (ANNO.qi !== qiAtEntry) return;
      // 接口异常响应（如 error 对象）无 shapes：按空处理，避免 setShapes 抛 TypeError
      ANNO.editor.setShapes(Array.isArray(boxes.shapes) ? boxes.shapes : []);
      ANNO.editor.rel = it.image;              // 编辑器内容与当前图一致，允许保存
      ANNO.editor._original = JSON.parse(JSON.stringify(ANNO.editor.shapes));   // 改动检测基准
      renderAnnoBoxList();
      syncAnnoLabelActive();
    }
  } else {
    $("#anno-text-card").innerHTML = `
      <div class="anno-text-main">${esc(it.text)}</div>
      <div class="anno-text-meta">${esc(it.src_label || "")}${it.label_path ? " · 已标：" + esc(it.label_path) : ""}</div>`;
    $("#anno-tmeta").textContent = `第 ${ANNO.qi + 1} / ${ANNO.queue.length} 条（本组）`;
    // 回显已有标注
    $$("#anno-tlabel-grid .lg-btn").forEach(b =>
      b.classList.toggle("active", it.label_path === b.dataset.l));
  }
}

function renderAnnoBoxList() {
  const ed = ANNO.editor;
  $("#anno-box-list").innerHTML = ed.shapes.length
    ? ed.shapes.map((s, i) => `
      <span class="box-chip ${i === ed.selected ? "selected" : ""}" data-i="${i}">
        ${esc(s.label)} ${s.pt ? "◉" : s.line ? "╱" : "◻"} ${shapeDesc(s)}
        <span class="x" data-del="${i}">×</span></span>`).join("")
    : `<span class="muted">暂无标注</span>`;
  $("#anno-box-list").querySelectorAll(".box-chip").forEach(ch =>
    ch.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) {
        ed.shapes.splice(+e.target.dataset.del, 1);
        ed.selected = -1;
      } else {
        ed.selected = +ch.dataset.i;
      }
      ed.draw();
      renderAnnoBoxList();
    }));
}

async function annoPickLabel(label) {
  const it = ANNO.queue[ANNO.qi];
  if (!it) return;
  if (ANNO.line === "image") {
    const r = await api("/api/classify", {
      method: "POST", body: { image: it.image, label_path: label },
    });
    if (!r.ok) return toast(r.error || "保存失败", false);
    it.classified = label;
  } else {
    const r = await api("/api/text_pool/decide", {
      method: "POST", body: { id: it.id, label_path: label },
    });
    if (!r.ok) return toast(r.error || "保存失败", false);
    it.label_path = label;
  }
  toast(`已保存：${label}`);
  annoNext();
}

function annoNext() {
  if (ANNO.qi + 1 < ANNO.queue.length) annoShow(ANNO.qi + 1);
  else if (ANNO.offset + ANNO.queue.length < ANNO.total) annoLoadGroup(ANNO.offset + ANNO.group);
  else toast("全部标注完成 🎉");
}

async function annoLoadGroup(newOffset) {
  if (newOffset < 0 || newOffset >= ANNO.total) return;
  if (!await saveAnnoIfDirty()) return;    // 切组前自动保存当前图（失败不切，防丢）
  ANNO.offset = newOffset;
  await annoLoadQueue();
  if (!ANNO.queue.length) return toast("该组没有内容", false);
  annoShow(0);
}

// 检测模式：保存当前图的形状（框/点）；成功返回 true
async function saveAnnoBoxes() {
  const it = ANNO.queue[ANNO.qi];
  if (!it || !ANNO.editor) return false;
  if (ANNO._saving) return false;                       // 双击/连点防重入
  if (ANNO.editor.rel !== it.image) {                   // 加载竞态守卫：编辑器不是当前图的内容
    toast("图片加载中，请稍候再保存", false);
    return false;
  }
  ANNO._saving = true;
  try {
    const r = await api("/api/boxes", {
      method: "POST",
      body: { image: it.image, shapes: shapesToBody(ANNO.editor.shapes) },
    });
    if (r.ok) {
      toast(`已保存 ${r.saved} 个标注`);
      it.has_boxes = true;
      ANNO.editor._original = JSON.parse(JSON.stringify(ANNO.editor.shapes));   // 刷新改动基准
      return true;
    }
    toast(r.error || "保存失败", false);
    return false;
  } finally {
    ANNO._saving = false;
  }
}

// 检测模式：当前图相对加载时有改动才保存（翻页/切组/退出等离开动作前调用）；
// 返回 false = 有改动但保存失败，调用方应阻止离开
async function saveAnnoIfDirty() {
  const it = ANNO.queue[ANNO.qi];
  if (ANNO.line !== "image" || ANNO.taskType !== "detect") return true;
  if (!it || !ANNO.editor || ANNO.editor.rel !== it.image) return true;   // 加载中/无编辑器
  const o = ANNO.editor._original;
  if (!o) return true;    // 无基准（异常兜底）：交由显式保存处理
  if (JSON.stringify(shapesToBody(ANNO.editor.shapes)) === JSON.stringify(shapesToBody(o))) return true;
  return await saveAnnoBoxes();
}

$("#anno-save-boxes").addEventListener("click", async () => {
  if (await saveAnnoIfDirty()) annoNext();
});

$("#anno-prev").addEventListener("click", async () => {
  if (!await saveAnnoIfDirty()) return;    // 回看上一张前自动保存当前图
  annoShow(ANNO.qi - 1);
});
$("#anno-next").addEventListener("click", async () => {
  // 检测模式下「保存并下一张」与检测面板按钮同语义：先保存框再翻页（避免两个按钮行为不一致）
  if (await saveAnnoIfDirty()) annoNext();
});
$("#anno-tprev").addEventListener("click", () => annoShow(ANNO.qi - 1));
$("#anno-tnext").addEventListener("click", () => annoNext());
$("#anno-prev-group").addEventListener("click", () => annoLoadGroup(ANNO.offset - ANNO.group));
$("#anno-next-group").addEventListener("click", () => annoLoadGroup(ANNO.offset + ANNO.group));

$("#anno-exit").addEventListener("click", async () => {
  if (!await saveAnnoIfDirty()) return;    // 退出前自动保存当前图改动（失败不退出，防丢）
  setAnnoLabelEdit(false);   // 退出时丢弃未确认的标签编辑
  document.body.classList.remove("anno-full");
  nav(ANNO.line === "image" ? "image" : "text");
});

$("#anno-export").addEventListener("click", async () => {
  const r = await api("/api/annotate/export", {
    method: "POST",
    body: { line: ANNO.line, task_type: ANNO.taskType, format: ANNO.format,
            start: ANNO.start, group: ANNO.group, labels: ANNO.labels },
  });
  if (r.ok) {
    const skipped = [
      r.points_skipped ? `${r.points_skipped} 个点` : "",
      r.lines_skipped ? `${r.lines_skipped} 条线` : "",
    ].filter(Boolean).join("、");
    toast(`已导出 ${r.count} 项 → ${r.file}` +
      (skipped ? `（${skipped}不适用该格式，点/线请用 txt 导出）` : ""));
  }
  else toast(r.error || "导出失败", false);
});

$("#cfg-go").onclick = enterAnno;

// 标注页键盘：1-9 选标签、←→ 翻页（标签编辑态不响应，避免误标）
document.addEventListener("keydown", async (e) => {
  if (!document.body.classList.contains("anno-full")) return;
  if (ANNO.labelEdit) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (e.key >= "1" && e.key <= "9") {
    const idx = +e.key - 1;
    if (ANNO.labels[idx]) {
      // 检测模式：切换当前框标签；分类/文本：选标签保存并下一条
      if (ANNO.line === "image" && ANNO.taskType === "detect") {
        $("#anno-box-label").value = ANNO.labels[idx];
        syncAnnoLabelActive();
      } else {
        annoPickLabel(ANNO.labels[idx]);
      }
    }
  } else if (e.key === "ArrowRight") {
    // 检测模式：键盘 → 与按钮同语义（先保存再翻页）
    if (await saveAnnoIfDirty()) annoNext();
  } else if (e.key === "ArrowLeft") {
    if (!await saveAnnoIfDirty()) return;    // 回看前自动保存当前图改动
    annoShow(ANNO.qi - 1);
  }
});

// ---------- 启动 ----------
(async function init() {
  try {
    renderUserBadge();
    if (!S.user) await ensureUser();   // 启动时引导设置昵称（可「暂不设置」，仅浏览）
    const sess = await api("/api/session");   // 携带 X-User：自动加入项目成员表
    if (sess.user && sess.user !== S.user) { S.user = sess.user; renderUserBadge(); }
    renderProjSelect(sess);
    $("#inp-folder").value = sess.folder || "";
    if (sess.loaded || sess.resumable) {
      // 有可恢复的会话（含服务重启后）：由用户选择「读取上次记录」或重新上传
      $("#btn-dash-resume").style.display = "";
      $("#dash-resume-info").style.display = "";
      $("#dash-resume-info").textContent = sess.loaded
        ? `上次会话数据：${sess.folder || "（未知目录）"}`
        : `检测到上次使用的数据：${sess.folder || ""}（服务已重启，读取时将重新解析）`;
      loadDashboard();   // S.probe 为空 → 显示空状态页并隐藏右上角上传按钮
    } else {
      showImport();
    }
  } catch (e) {
    showImport();
  }
})();