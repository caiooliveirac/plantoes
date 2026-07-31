# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:25-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM --platform=$BUILDPLATFORM node:25-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# O projeto não tem pasta public/ hoje — garante que ela exista de qualquer
# forma para o COPY --from=build /app/public do estágio runtime nunca falhar.
RUN mkdir -p public

# Sem --platform aqui (propositalmente): este é o único estágio cujo
# node_modules vai para a imagem final (runtime, $TARGETPLATFORM=arm64). Rodar
# em $BUILDPLATFORM instalaria binários nativos da arquitetura errada.
FROM node:25-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# Sem --omit=dev: o worker de lembretes roda via 'npm run telegram:worker' →
# tsx, que é devDependency. Precisa estar presente em produção.
RUN npm ci

FROM --platform=$TARGETPLATFORM node:25-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3004

RUN useradd --system --uid 10001 --create-home --home-dir /home/app app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/lib ./lib
COPY --from=build /app/modules ./modules
COPY --from=build /app/services ./services
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.deploy.json ./tsconfig.deploy.json

RUN chown -R app:app /app
USER app

EXPOSE 3004

CMD ["npm", "start"]
