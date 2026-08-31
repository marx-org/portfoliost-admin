FROM node:22-alpine

WORKDIR /app

ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY drizzle/ drizzle/
COPY src/ src/

RUN npm run build

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run db:migrate && node dist/server.js"]
