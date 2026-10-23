FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=8888
EXPOSE 8888
CMD ["node", "--experimental-strip-types", "src/server.ts"]
