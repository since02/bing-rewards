# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Microsoft Rewards 中文面板（自包含，零 npm 依赖）
# 本地 COPY 项目内源码（server.js / lib / public），不克隆任何上游仓库。
# 通过 HTTP 连接机器人 Control API（Bearer 鉴权），并可选经挂载的
# /var/run/docker.sock 完成「账户增删」「手动登录容器拉起」。
# ---------------------------------------------------------------------------
FROM node:24-slim

WORKDIR /usr/src/rewards-dashboard

ENV NODE_ENV=production \
    PORT=8890 \
    DATA_DIR=/data

# 只取运行必需文件（.dockerignore 已排除 node_modules / data / .git）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data

EXPOSE 8890

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const u=process.env.DASHBOARD_USERNAME||'';const p=process.env.DASHBOARD_PASSWORD||'';const h=(u&&p)?{Authorization:'Basic '+Buffer.from(u+':'+p).toString('base64')}:{};fetch('http://127.0.0.1:'+(process.env.PORT||8890)+'/api/health',{headers:h}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
