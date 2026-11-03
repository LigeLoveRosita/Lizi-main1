# 李子视奸朋友的网站 —— 云服务器部署
#
# 构建：docker build -t lizi-watch .
# 运行：docker run -d -p 8899:8899 -v $PWD/data:/app/data --name lizi lizi-watch
# 访问：http://服务器IP:8899 （首次访问需要控制台打印的访问码）

FROM node:20-alpine

WORKDIR /app

# 无第三方依赖，不需要 npm install
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8899

EXPOSE 8899

# 登录 Cookie 与数据都在这里，务必挂载持久化
VOLUME ["/app/data"]

CMD ["node", "server.js"]
