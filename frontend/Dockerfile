# ---- DrC Management frontend (Vite build -> nginx) ----

# 1) Build the static SPA
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) Serve the built assets with nginx, which also reverse-proxies /api and the
#    SSE stream to the backend container (single origin, no CORS).
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
