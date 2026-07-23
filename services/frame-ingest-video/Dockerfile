FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS builder

ARG SRT_COMMIT=c63c311e88aa55e430e3b7d94b89d790994f88c4
ARG SRTLA_COMMIT=2b19d400d88f2a35ad225d2ea048c04335e69803
ARG SLS_COMMIT=e0348adbd02ce5f5400e452bbac630f42989c6bc
ARG RECEIVER_COMMIT=8aec40eaf55f1c0be4c9779cec649d66fea0a36f

ENV LD_LIBRARY_PATH=/lib:/usr/lib:/usr/local/lib64
WORKDIR /src

RUN apk add --no-cache \
      alpine-sdk cmake linux-headers openssl-dev spdlog-dev sqlite-dev tcl zlib-dev \
    && git clone https://github.com/Haivision/srt.git \
    && git -C srt checkout "$SRT_COMMIT" \
    && git clone --recurse-submodules https://github.com/OpenIRL/srtla.git \
    && git -C srtla checkout "$SRTLA_COMMIT" \
    && git -C srtla submodule update --init --recursive \
    && git clone https://github.com/OpenIRL/srt-live-server.git \
    && git -C srt-live-server checkout "$SLS_COMMIT" \
    && git clone https://github.com/OpenIRL/srtla-receiver.git receiver \
    && git -C receiver checkout "$RECEIVER_COMMIT"

COPY openirl-srtla-v1.5.6.patch /tmp/openirl-srtla-v1.5.6.patch

RUN git -C srt apply --check /tmp/openirl-srtla-v1.5.6.patch \
    && git -C srt apply /tmp/openirl-srtla-v1.5.6.patch \
    && cd srt \
    && ./configure --disable-static \
    && make -j"$(nproc)" \
    && make install \
    && srt-live-transmit -version 2>&1 | grep -F "SRT Library version: 1.5.6" \
    && nm -D /usr/local/lib/libsrt.so | grep -F " srt_srtla_stats" \
    && grep -F "SRTO_SRTLAPATCHES = 120" /usr/local/include/srt/srt.h \
    && cd /src/srtla \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel \
    && cd /src/srt-live-server \
    && make -j"$(nproc)"

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

LABEL org.opencontainers.image.title="FRAME Video Ingest"
LABEL org.opencontainers.image.description="FRAME source build of the OpenIRL SRTLA Receiver"
LABEL org.opencontainers.image.source="https://github.com/gall-levi-code/Syronius_FRAME"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
LABEL org.opencontainers.image.version="OpenIRL-receiver-1.2.0-srt-1.5.6"

ENV LD_LIBRARY_PATH=/lib:/usr/lib:/usr/local/lib64
ENV SRTLA_LOG_LEVEL=info

RUN apk add --no-cache coreutils libstdc++ openssl perl spdlog sqlite supervisor \
    && adduser -D -u 3001 -s /bin/sh sls \
    && adduser -D -u 3002 -s /bin/sh srtla

COPY --from=builder /src/srt-live-server/bin/ /usr/local/bin/
COPY --from=builder /src/srtla/build/srtla_rec /usr/local/bin/srtla_rec
COPY --from=builder /usr/local/bin/srt-live-transmit /usr/local/bin/
COPY --from=builder /usr/local/lib/libsrt.so* /usr/local/lib/
COPY --from=builder /src/srt-live-server/sls.conf /etc/sls/sls.conf
COPY --from=builder /src/receiver/conf/supervisord.conf /etc/supervisord.conf
COPY --from=builder /src/receiver/bin/logprefix /bin/logprefix
COPY --from=builder /src/srt/LICENSE /usr/share/licenses/frame-ingest-video/SRT-LICENSE.txt
COPY --from=builder /src/srtla/LICENSE /usr/share/licenses/frame-ingest-video/SRTLA-LICENSE.txt
COPY --from=builder /src/srt-live-server/LICENSE /usr/share/licenses/frame-ingest-video/SLS-LICENSE.txt
COPY frame-init.sh /usr/local/bin/frame-init
COPY OPENIRL-LICENSE.txt /usr/share/licenses/frame-ingest-video/OPENIRL-RECEIVER-LICENSE.txt

RUN chmod 755 /bin/logprefix /usr/local/bin/frame-init /usr/local/bin/srtla_rec \
    && srt-live-transmit -version 2>&1 | grep -F "SRT Library version: 1.5.6" \
    && ldd /usr/local/bin/sls | grep -F "/usr/local/lib/libsrt.so.1.5"

EXPOSE 4000/udp 4001/udp 5000/udp 8080/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/frame-init"]
CMD ["/usr/bin/supervisord", "--nodaemon", "--configuration", "/etc/supervisord.conf"]
