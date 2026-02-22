FROM rust:1.85 as builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev

WORKDIR /usr/src/sarbule

# Skopiuj pliki zależności i zbuduj je w pierwszej kolejności (dla cache'owania)
COPY Cargo.toml Cargo.lock ./
RUN mkdir src/
RUN echo "fn main() {}" > src/main.rs
RUN cargo build --release

# Skopiuj resztę kodu backendu
COPY src/ ./src/

# Skopiuj pliki statyczne frontendu
COPY templates/ ./templates
COPY assets/ ./assets

# Zbuduj finalną aplikację
RUN touch src/main.rs
RUN cargo build --release

# Używam lekkiego obrazu Debiana
FROM debian:12-slim

# Zainstaluj ca-certificates (potrzebne do HTTPS połączenia z Turso)
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Ustaw folder roboczy
WORKDIR /usr/src/sarbule

# Skopiuj skompilowaną aplikację Rust z etapu "builder"
COPY --from=builder /usr/src/sarbule/target/release/sarbule .

# Skopiuj potrzebne pliki statyczne z etapu "builder"
COPY --from=builder /usr/src/sarbule/templates ./templates
COPY --from=builder /usr/src/sarbule/assets ./assets

# Render ustawia PORT automatycznie
ENV PORT=3000

# Polecenie, które zostanie uruchomione, gdy kontener wystartuje
CMD ["./sarbule"]
