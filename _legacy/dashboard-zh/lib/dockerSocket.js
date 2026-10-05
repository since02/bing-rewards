"use strict";

// 通过挂载的 /var/run/docker.sock 直接调用 Docker HTTP API（无需在镜像内安装 docker CLI）。
// 仅使用本项目需要的几个操作：版本检测、重启容器、创建+启动一次性容器（手动登录）。

const http = require("node:http");
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";

function dockerRequest(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        method,
        path: p,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          if ((res.statusCode || 0) >= 400) {
            return reject(
              new Error((parsed && parsed.message) || text || `Docker ${res.statusCode}`),
            );
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function available() {
  try {
    const r = require("node:fs").accessSync(DOCKER_SOCK);
    return true;
  } catch {
    return false;
  }
}

function version() {
  return dockerRequest("GET", "/version");
}

// 重启指定容器（通过名称）
async function restartContainer(name) {
  await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/restart?t=5`);
  return true;
}

// 删除同名容器（若已存在）
async function removeContainer(name) {
  try {
    await dockerRequest(
      "DELETE",
      `/containers/${encodeURIComponent(name)}?force=true&v=false`,
    );
  } catch (e) {
    // 不存在等问题可忽略
  }
  return true;
}

// 创建并启动一个手动登录容器（noVNC）
async function runManualLogin({ name, image, email, scope, envPass, sessionsVolume, configVolume, port }) {
  await removeContainer(name);
  const body = {
    Image: image,
    Cmd: [
      "bash",
      "/usr/src/microsoft-rewards-script/scripts/docker/manual-login.sh",
      email,
      scope,
    ],
    Env: envPass,
    HostConfig: {
      Binds: [
        `${sessionsVolume}:/usr/src/microsoft-rewards-script/sessions`,
        `${configVolume}:/usr/src/microsoft-rewards-script/config`,
      ],
      PortBindings: {
        "6901/tcp": [{ HostPort: String(port) }],
      },
      AutoRemove: false,
    },
  };
  const created = await dockerRequest(
    "POST",
    `/containers/create?name=${encodeURIComponent(name)}`,
    body,
  );
  await dockerRequest("POST", `/containers/${created.Id}/start`);
  return created.Id;
}

module.exports = {
  available,
  version,
  restartContainer,
  removeContainer,
  runManualLogin,
};
