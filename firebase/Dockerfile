# Firebase Auth Emulator oficial (firebase-tools). Solo para pruebas locales: guarda los usuarios en memoria.
FROM node:22-bookworm-slim
RUN npm install -g firebase-tools@15.34.2 --no-audit --no-fund && npm cache clean --force
WORKDIR /srv
COPY firebase.json ./
EXPOSE 9099
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "lendup-desarrollo"]
