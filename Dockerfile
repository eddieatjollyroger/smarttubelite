FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH

# yt-dlp is a self-contained binary; no python/ffmpeg needed because this server
# never transcodes or muxes, it only reads stream URLs and proxies bytes.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      arm64|aarch64) asset=yt-dlp_linux_aarch64 ;; \
      amd64|x86_64)  asset=yt-dlp_linux ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \
      -o /usr/local/bin/yt-dlp; \
    chmod 755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
RUN mkdir -p /app/data

ENV PORT=8484 \
    HOST=0.0.0.0 \
    YTDLP=/usr/local/bin/yt-dlp

EXPOSE 8484

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
