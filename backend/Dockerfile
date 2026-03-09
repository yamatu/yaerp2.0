FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /yaerp-server .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates tzdata postgresql16-client
ENV TZ=Asia/Shanghai

COPY --from=builder /yaerp-server /yaerp-server

EXPOSE 8080
CMD ["/yaerp-server"]
