use crate::{
    db,
    error::AppError,
    models::{Event, TimeOfDay, User},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct UserPayload {
    name: String,
}

#[derive(Serialize)]
pub enum LoginStatus {
    Exists,
    Created,
}

#[derive(Serialize)]
pub struct LoginResponse {
    status: LoginStatus,
    user: User,
}

async fn validate_user_exists(pool: &sqlx::SqlitePool, user_id: i64) -> Result<(), AppError> {
    sqlx::query("SELECT id FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Uzytkownik o podanym ID nie istnieje.".to_string()))?;
    Ok(())
}

pub async fn login_or_register_user(
    State(app_state): State<AppState>,
    Json(payload): Json<UserPayload>,
) -> Result<Json<LoginResponse>, AppError> {
    match db::find_user_by_name(&app_state.pool, &payload.name).await? {
        Some(user) => Ok(Json(LoginResponse {
            status: LoginStatus::Exists,
            user,
        })),
        None => {
            let new_user = db::create_user(&app_state.pool, &payload.name).await?;
            Ok(Json(LoginResponse {
                status: LoginStatus::Created,
                user: new_user,
            }))
        }
    }
}

pub async fn get_events(State(app_state): State<AppState>) -> Result<Json<Vec<Event>>, AppError> {
    db::get_all_events(&app_state.pool).await.map(Json)
}

#[derive(Debug, Serialize)]
pub struct EventDetails {
    event: Event,
    unavailability_details: HashMap<String, HashMap<String, String>>,
}

pub async fn get_event_details(
    State(app_state): State<AppState>,
    Path(public_id): Path<String>,
) -> Result<Json<EventDetails>, AppError> {
    let event = sqlx::query_as::<_, Event>("SELECT * FROM events WHERE public_id = ?")
        .bind(&public_id)
        .fetch_optional(&app_state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    let unavailability_details =
        db::get_event_unavailability_details(&app_state.pool, event.id).await?;
    Ok(Json(EventDetails {
        event,
        unavailability_details,
    }))
}

#[derive(Deserialize)]
pub struct AddUnavailabilityPayload {
    user_id: i64,
    start_date: NaiveDate,
    end_date: NaiveDate,
    times_of_day: Vec<TimeOfDay>,
}

pub async fn add_event_unavailability(
    State(app_state): State<AppState>,
    Path(public_id): Path<String>,
    Json(payload): Json<AddUnavailabilityPayload>,
) -> Result<StatusCode, AppError> {
    validate_user_exists(&app_state.pool, payload.user_id).await?;
    
    let event_id: (i64,) = sqlx::query_as("SELECT id FROM events WHERE public_id = ?")
        .bind(public_id)
        .fetch_optional(&app_state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::add_unavailability(
        &app_state.pool,
        event_id.0,
        payload.user_id,
        payload.start_date,
        payload.end_date,
        payload.times_of_day,
    )
    .await?;
    Ok(StatusCode::CREATED)
}

pub async fn remove_event_unavailability(
    State(app_state): State<AppState>,
    Path(public_id): Path<String>,
    Json(payload): Json<AddUnavailabilityPayload>,
) -> Result<StatusCode, AppError> {
    validate_user_exists(&app_state.pool, payload.user_id).await?;

    let event_id: (i64,) = sqlx::query_as("SELECT id FROM events WHERE public_id = ?")
        .bind(public_id)
        .fetch_optional(&app_state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::remove_unavailability(
        &app_state.pool,
        event_id.0,
        payload.user_id,
        payload.start_date,
        payload.end_date,
        payload.times_of_day,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ClearPayload {
    user_id: i64,
}

pub async fn clear_my_unavailabilities_handler(
    State(app_state): State<AppState>,
    Path(public_id): Path<String>,
    Json(payload): Json<ClearPayload>,
) -> Result<StatusCode, AppError> {
    validate_user_exists(&app_state.pool, payload.user_id).await?;

    let event_id: (i64,) = sqlx::query_as("SELECT id FROM events WHERE public_id = ?")
        .bind(public_id)
        .fetch_optional(&app_state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::clear_user_unavailabilities(&app_state.pool, event_id.0, payload.user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct CreateEventPayload {
    name: String,
    description: Option<String>,
    earliest: NaiveDate,
    latest: NaiveDate,
}

pub async fn create_event_handler(
    State(app_state): State<AppState>,
    Json(payload): Json<CreateEventPayload>,
) -> Result<Json<Event>, AppError> {
    let new_event = db::create_event(
        &app_state.pool,
        &payload.name,
        payload.description,
        payload.earliest,
        payload.latest,
    )
    .await?;
    Ok(Json(new_event))
}