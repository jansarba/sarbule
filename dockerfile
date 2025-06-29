FROM rust:1.85 as builder

RUN apt-get update && apt-get install -y nodejs npm

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

# Skopiuj pliki zależności frontendu i zainstaluj je
COPY package.json package-lock.json ./
RUN npm install

# Używam lekkiego obrazu Debiana
FROM debian:12-slim

# Ustaw folder roboczy
WORKDIR /usr/src/sarbule

# Skopiuj skompilowaną aplikację Rust z etapu "builder"
COPY --from=builder /usr/src/sarbule/target/release/sarbule .

# Skopiuj potrzebne pliki statyczne z etapu "builder"
COPY --from=builder /usr/src/sarbule/templates ./templates
COPY --from=builder /usr/src/sarbule/assets ./assets
COPY --from=builder /usr/src/sarbule/node_modules ./node_modules

# Ustaw zmienną środowiskową, aby Axum nasłuchiwał na poprawnym porcie
ENV PORT=3000

# Polecenie, które zostanie uruchomione, gdy kontener wystartuje
CMD ["./sarbule"]