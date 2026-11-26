FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Pre-fetch the 107,149-manuscript catalog bundle into /app/data for instant cold starts
RUN node scripts/ensure-data.js || true

ENV NODE_ENV=production
ENV PORT=3456
ENV ALQAMAR_MOON_URL=https://mooon.site/moon/

EXPOSE 3456

CMD ["sh", "-c", "node scripts/ensure-data.js && node server/server.js"]
