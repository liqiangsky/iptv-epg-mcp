# 使用 Node.js 20 LTS 作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 增加 Node.js 堆内存限制（Koyeb/Railway 免费实例 ~512MB RAM）
ENV NODE_OPTIONS="--max-old-space-size=384"

# 复制依赖配置文件并安装
COPY package*.json ./
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露服务端口
EXPOSE 7860

# 启动 HTTP/SSE 服务器
CMD ["node", "--max-old-space-size=384", "http-server.js"]