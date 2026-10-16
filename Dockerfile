# ---------- 构建阶段 ----------
FROM node:20-bookworm AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-bookworm
ENV NODE_ENV=production

# Unity Linux Editor 运行依赖 + git + xz（解压 Unity 安装包）
RUN apt-get update && apt-get install -y --no-install-recommends \
    git xz-utils ca-certificates \
    libglu1 libxkbcommon0 libx11-6 libxcb1 libxcursor1 libxrandr2 \
    libxi6 libgtk-3-0 libnss3 libasound2 libxss1 libxtst6 libgconf-2-4 \
    && rm -rf /var/lib/apt/lists/* || true

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist

ENV PORT=7850
ENV UCL_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 7850

CMD ["node", "server/dist/main.js"]
