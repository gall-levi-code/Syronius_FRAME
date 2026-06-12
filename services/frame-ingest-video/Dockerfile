FROM ghcr.io/openirl/srtla-receiver@sha256:3202ba3584864273ff7293a4e81a0983acda71d5a79e1a2da2b7bcf0b98db2f8

LABEL org.opencontainers.image.title="FRAME Video Ingest"
LABEL org.opencontainers.image.description="FRAME wrapper for the OpenIRL SRTLA Receiver"
LABEL org.opencontainers.image.source="https://github.com/gall-levi-code/Syronius_FRAME"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"

USER root
RUN apk add --no-cache sqlite
COPY frame-init.sh /usr/local/bin/frame-init
COPY OPENIRL-LICENSE.txt /usr/share/licenses/frame-ingest-video/OPENIRL-LICENSE.txt
RUN chmod 755 /usr/local/bin/frame-init

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/frame-init"]
CMD ["/usr/bin/supervisord", "--nodaemon", "--configuration", "/etc/supervisord.conf"]
