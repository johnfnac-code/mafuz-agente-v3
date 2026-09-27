FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY . .
RUN mkdir -p assets/fontes /app/data && (mv -f Jost-*.ttf assets/fontes/ 2>/dev/null || true)
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
