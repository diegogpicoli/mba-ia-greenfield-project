FROM golang:1.24-alpine AS build

RUN CGO_ENABLED=0 go install github.com/minio/minio@9e49d5e7a648

FROM alpine:3.22

RUN apk add --no-cache curl

COPY --from=build /go/bin/minio /usr/local/bin/minio

EXPOSE 9000

CMD [ "minio", "server", "/data" ]
