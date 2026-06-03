# ===========================================================================
# Dockerfile — Frontend PulmoSeg-3D (React + Vite → Nginx)
#
# Build multistage:
#   Stage 1 (builder): Node 20 Alpine → compila el bundle de producción
#   Stage 2 (runner):  Nginx Alpine   → sirve el build estático
#
# VITE_API_KEY se inyecta como build argument (no queda en la imagen final
# ya que Nginx solo sirve archivos estáticos del bundle compilado).
#
# Uso:
#   docker compose build frontend
#   docker compose up frontend
# ===========================================================================

# ===========================================================================
# Stage 1: Builder — Compilación del bundle de producción
# ===========================================================================
FROM node:20-alpine AS builder

LABEL stage="builder"

WORKDIR /app

# ---------------------------------------------------------------------------
# Instalar dependencias
# ---------------------------------------------------------------------------
# Copiar archivos de lock ANTES del código fuente para aprovechar cache.
# npm ci: instalación limpia y determinista (usa package-lock.json).
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Build argument para la API Key del frontend
# ---------------------------------------------------------------------------
# La API Key se embebe en el bundle en tiempo de compilación (Vite reemplaza
# import.meta.env.VITE_API_KEY). En producción real, usar un proxy en el
# backend que no exponga la clave al cliente.
# Las variables VITE_API_KEY y VITE_API_BASE_URL se leen automáticamente
# desde el archivo .env.production gracias a Vite.

# ---------------------------------------------------------------------------
# Compilar la aplicación
# ---------------------------------------------------------------------------
COPY . .
RUN npm run build

# ===========================================================================
# Stage 2: Runner — Servidor Nginx con el bundle estático
# ===========================================================================
FROM nginx:1.27-alpine AS runner

LABEL maintainer="PulmoSeg-3D"
LABEL description="Frontend React servido por Nginx con proxy al backend FastAPI"

# ---------------------------------------------------------------------------
# Bundle de producción desde el stage builder
# ---------------------------------------------------------------------------
COPY --from=builder /app/dist /usr/share/nginx/html

# ---------------------------------------------------------------------------
# Configuración de Nginx
# ---------------------------------------------------------------------------
# Se reemplaza la configuración por defecto con una personalizada que:
#   1. Configura el fallback para React Router (SPA)
#   2. Proxy /api/ → http://backend:8000/ (nombre de servicio Docker Compose)
#   3. Permite uploads grandes de DICOM (hasta 512 MB)
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
