FROM node:22-alpine AS dependencies
WORKDIR /app
COPY backend/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/src ./src
COPY backend/migrations ./migrations
EXPOSE 8080
USER node
CMD ["npm", "run", "start"]
