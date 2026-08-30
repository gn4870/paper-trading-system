FROM node:lts-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:lts-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace=@paper/server --workspace=@paper/shared
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "const http=require('node:http');const request=http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health'},response=>process.exit(response.statusCode===200?0:1));request.on('error',()=>process.exit(1));request.setTimeout(2000,()=>{request.destroy();process.exit(1)});"
CMD ["node", "apps/server/dist/server.js"]
