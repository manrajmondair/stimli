FROM node:22-slim

WORKDIR /app

COPY package*.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --workspace stimli-frontend

COPY frontend ./frontend

EXPOSE 5173
CMD ["npm", "run", "dev", "--workspace", "stimli-frontend", "--", "--host", "0.0.0.0", "--port", "5173"]
