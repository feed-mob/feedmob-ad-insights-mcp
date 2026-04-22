FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

ENV NODE_ENV=production
ENV MONGO_URI=mongodb://admin:tpBBr4qsmAjBQ6ib6YJ1KE7F4@18.209.12.168:27017/feedmob_db?authSource=admin

EXPOSE 3000

CMD ["node", "src/index.js"]
