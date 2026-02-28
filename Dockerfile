FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S fabric && adduser -S -G fabric -u 1001 fabric
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER fabric
# PIPELINE_NAME selects which pipeline runs (e.g. 1-security-triage)
ENV PIPELINE_NAME=1-security-triage
CMD ["sh", "-c", "node dist/${PIPELINE_NAME}/pipeline.js"]
