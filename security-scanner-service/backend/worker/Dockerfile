FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY tools ./tools
USER node
CMD ["node", "src/main.js"]
