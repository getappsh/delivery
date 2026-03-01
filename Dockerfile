FROM node:19.5.0-alpine as build
WORKDIR /node-app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run test
RUN npm run build

FROM node:19.5.0-alpine as deploy
ENV NODE_ENV=production
WORKDIR /node-app
COPY package*.json ./
RUN npm install --only=production --omit=dev
COPY --from=build /node-app/dist/apps/delivery/* .
CMD ["node", "main.js"]