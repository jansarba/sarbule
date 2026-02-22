mod db;
mod error;
mod handlers;
mod models;
mod state;

use axum::{
    response::Html,
    routing::{delete, get, post},
    Router,
};
use chrono::NaiveDate;
use libsql::Builder;
use state::AppState;
use std::env;
use tower_http::services::ServeDir;

async fn root_handler() -> Html<String> {
    tokio::fs::read_to_string("templates/index.html")
        .await
        .map(Html)
        .unwrap_or_else(|_| Html("<h1>Blad: Nie mozna zaladowac pliku index.html</h1>".to_string()))
}

async fn seed_database_if_empty(conn: &libsql::Connection) {
    let mut rows = conn
        .query("SELECT COUNT(*) FROM events", ())
        .await
        .expect("Failed to check event count");

    let count: i64 = rows
        .next()
        .await
        .expect("Failed to get count row")
        .expect("No count row")
        .get(0)
        .expect("Failed to get count value");

    if count == 0 {
        println!("Baza danych jest pusta. Dodaje wydarzenie 'grill u Janka'...");
        let name = "grill u Janka";
        let description = Some("witam".to_string());
        let earliest = NaiveDate::from_ymd_opt(2025, 7, 5).unwrap();
        let latest = NaiveDate::from_ymd_opt(2025, 9, 30).unwrap();

        match db::create_event(conn, name, description, earliest, latest).await {
            Ok(_) => println!("Wydarzenie zostalo pomyslnie dodane."),
            Err(e) => eprintln!("Nie udalo sie dodac wydarzenia: {:?}", e),
        }
    }
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let db = if let Ok(url) = env::var("TURSO_DATABASE_URL") {
        let token = env::var("TURSO_AUTH_TOKEN")
            .expect("TURSO_AUTH_TOKEN must be set when TURSO_DATABASE_URL is set");
        Builder::new_remote(url, token)
            .build()
            .await
            .expect("failed to connect to Turso")
    } else {
        let path = env::var("DATABASE_URL").unwrap_or_else(|_| "sarbule_local.db".to_string());
        Builder::new_local(&path)
            .build()
            .await
            .expect("failed to create local database")
    };

    let conn = db.connect().expect("failed to create connection");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            public_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT,
            earliest DATE NOT NULL,
            latest DATE NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        (),
    )
    .await
    .expect("failed to create events table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )",
        (),
    )
    .await
    .expect("failed to create users table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS unavailabilities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            day DATE NOT NULL,
            time_of_day TEXT NOT NULL,
            FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            UNIQUE(event_id, user_id, day, time_of_day)
        )",
        (),
    )
    .await
    .expect("failed to create unavailabilities table");

    seed_database_if_empty(&conn).await;

    let app_state = AppState { db: std::sync::Arc::new(db) };

    let app = Router::new()
        .route("/", get(root_handler))
        .nest_service("/assets", ServeDir::new("assets"))
        .route("/api/users/login", post(handlers::login_or_register_user))
        .route(
            "/api/events",
            get(handlers::get_events).post(handlers::create_event_handler),
        )
        .route("/api/events/{public_id}", get(handlers::get_event_details))
        .route(
            "/api/events/{public_id}/availability",
            post(handlers::add_event_unavailability).delete(handlers::remove_event_unavailability),
        )
        .route(
            "/api/events/{public_id}/my-availability",
            delete(handlers::clear_my_unavailabilities_handler),
        )
        .with_state(app_state);

    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("slucham na {}", addr);
    axum::serve(listener, app).await.unwrap();
}
