FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm install

COPY backend/ .

COPY frontend/ ./public/

RUN mkdir -p ./public/qrcodes

EXPOSE 8000
CMD ["node", "index.js"]