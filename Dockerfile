ARG PG_MAJOR=18
ARG BASE=postgres:${PG_MAJOR}-trixie

FROM ${BASE} AS build
ARG PG_MAJOR
RUN apt-get update && apt-get install -y --no-install-recommends build-essential postgresql-server-dev-${PG_MAJOR}
WORKDIR /src
COPY extension/ ./
RUN make && make install DESTDIR=/out

FROM scratch AS extension
COPY --from=build /out/ /

FROM ${BASE}
COPY --from=build /out/ /
