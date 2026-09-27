FROM node:22-alpine
WORKDIR /app
# ffmpeg gera os vídeos verticais dos imóveis novos
RUN apk add --no-cache ffmpeg
COPY package.json ./
COPY src ./src
COPY conhecimento ./conhecimento
COPY assets ./assets
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
