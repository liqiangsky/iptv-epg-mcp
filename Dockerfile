# 使用 Node.js 20 LTS 作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖配置文件并安装
COPY package*.json ./
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露 HF Spaces 默认端口
EXPOSE 7860

# 启动 HTTP/SSE 服务器
CMD ["node", "http-server.js"]