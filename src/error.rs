use axum::{http::StatusCode, response::{IntoResponse, Response}};

#[derive(Debug)]
pub enum AppError {
    SqlxError(sqlx::Error),
    NotFound(String),
    BadRequest(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message) = match self {
            AppError::SqlxError(e) => {
                eprintln!("[DB ERROR]: {:?}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "blad serwera".to_string())
            }
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
        };
        (status, error_message).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::SqlxError(err)
    }
}