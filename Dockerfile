# 通用数据解析标注平台 — 服务端镜像
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# 先装依赖（利用镜像层缓存）
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && rm -rf /root/.cache/pip

# 拷贝代码（projects/、config.json 已被 .dockerignore 排除，经挂载注入）
COPY server.py image_audit.py ./
COPY static ./static

# 数据目录由应用启动时自建（projects/、/app/data），挂载持久化
ENV CONFIG_FILE=/app/data/config.json \
    REPORT_DIR=/app/data/reports

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8765/api/vlm/status',timeout=4)"

CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8765"]
