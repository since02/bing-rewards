# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Microsoft Rewards Bot (chiihero/Microsoft-Rewards-Script @ V4-china)
# 固定 commit 构建，避免上游漂移；国内本地化（中国热搜 / PushPlus 等）。
# 任务覆盖：桌面+移动搜索、每日集、更多促销、打卡、App 活动、每日签到、
#           阅读赚取、搜索加成 perk 等；并内置 Control API（API_MODE=true）。
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /usr/src/microsoft-rewards-script

# 浏览器与构建产物都落到镜像内（PLAYWRIGHT_BROWSERS_PATH=0 表示随项目存放）
ENV PLAYWRIGHT_BROWSERS_PATH=0

# 拉取源码（固定版本，可复现）
ARG REWARDS_REF=e0c15a6ae6bd102cb04f2a3351e2fa281f82961c
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
RUN git clone https://github.com/chiihero/Microsoft-Rewards-Script.git . && \
    git checkout -q "${REWARDS_REF}"

# 安装依赖并构建（先全量装以便构建，再裁剪为仅生产依赖以减小体积）
RUN npm ci --ignore-scripts

# 在固定 commit 源码上打「钉钉通知补丁」（仅插入调用 + 新增一个独立模块，不改上游逻辑）
COPY patches ./patches
RUN node patches/apply_patch.mjs

RUN npm run build
RUN rm -rf node_modules && npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# 运行阶段
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /usr/src/microsoft-rewards-script

# 说明：上游在应用 CONFIG_* 覆盖时，会强制把 config.headless 写成 true
# （FORCED_OVERRIDES），因此这里不需要、也没有任何 FORCE_HEADLESS 变量。
# 手动登录走 scripts/main/manualLogin.js，它内部硬编码 headless:false，同样不受影响。
ENV NODE_ENV=production \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Chromium 无头运行所需的系统库 + 运行时工具（cron/jq/envsubst/时区）
RUN apt-get update && apt-get install -y --no-install-recommends \
        cron \
        gettext-base \
        jq \
        tzdata \
        ca-certificates \
        libglib2.0-0 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libasound2 \
        libflac12 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libdrm2 \
        libgbm1 \
        libdav1d6 \
        libx11-6 \
        libx11-xcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        libdouble-conversion3 \
        fonts-liberation \
        fonts-noto-core \
        fonts-noto-color-emoji \
        fonts-freefont-ttf \
        fonts-droid-fallback \
        xvfb \
        x11vnc \
        novnc \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# 拷贝编译产物与运行时依赖
COPY --from=builder /usr/src/microsoft-rewards-script/dist ./dist
COPY --from=builder /usr/src/microsoft-rewards-script/package*.json ./
COPY --from=builder /usr/src/microsoft-rewards-script/node_modules ./node_modules
COPY --from=builder /usr/src/microsoft-rewards-script/config.example.json ./config.example.json
COPY --from=builder /usr/src/microsoft-rewards-script/scripts ./scripts
# 手动登录脚本（Docker 内 noVNC 可视化登录 2FA 账号）
COPY scripts/docker/manual-login.sh /usr/src/microsoft-rewards-script/scripts/docker/manual-login.sh
COPY --from=builder /usr/src/microsoft-rewards-script/src/crontab.template /etc/cron.d/microsoft-rewards-cron.template

# 入口脚本
COPY --from=builder /usr/src/microsoft-rewards-script/scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
    && chmod 755 /usr/src/microsoft-rewards-script/scripts/docker/*.sh

# 安装 Patchright 的防检测 Chromium（仅 headless shell）
# 直接调用本地 bin 而不是 npx，避免运行时再去 npm registry 解析包。
# 浏览器随 PLAYWRIGHT_BROWSERS_PATH=0 落在项目目录内，重建容器不会丢。
RUN set -eux; \
    ./node_modules/.bin/patchright install --with-deps --only-shell chromium; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["sh", "/usr/src/microsoft-rewards-script/scripts/docker/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Container started; cron is running.'"]
