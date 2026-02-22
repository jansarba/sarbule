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

pub async fn login_or_register_user(
    State(app_state): State<AppState>,
    Json(payload): Json<UserPayload>,
) -> Result<Json<LoginResponse>, AppError> {
    let conn = app_state.db.connect()?;
    match db::find_user_by_name(&conn, &payload.name).await? {
        Some(user) => Ok(Json(LoginResponse {
            status: LoginStatus::Exists,
            user,
        })),
        None => {
            let new_user = db::create_user(&conn, &payload.name).await?;
            Ok(Json(LoginResponse {
                status: LoginStatus::Created,
                user: new_user,
            }))
        }
    }
}

pub async fn get_events(State(app_state): State<AppState>) -> Result<Json<Vec<Event>>, AppError> {
    let conn = app_state.db.connect()?;
    db::get_all_events(&conn).await.map(Json)
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
    let conn = app_state.db.connect()?;
    let event = db::get_event_by_public_id(&conn, &public_id)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    let unavailability_details =
        db::get_event_unavailability_details(&conn, event.id).await?;
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
    let conn = app_state.db.connect()?;
    db::validate_user_exists(&conn, payload.user_id).await?;

    let event_id = db::get_event_id_by_public_id(&conn, &public_id)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::add_unavailability(
        &conn,
        event_id,
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
    let conn = app_state.db.connect()?;
    db::validate_user_exists(&conn, payload.user_id).await?;

    let event_id = db::get_event_id_by_public_id(&conn, &public_id)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::remove_unavailability(
        &conn,
        event_id,
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
    let conn = app_state.db.connect()?;
    db::validate_user_exists(&conn, payload.user_id).await?;

    let event_id = db::get_event_id_by_public_id(&conn, &public_id)
        .await?
        .ok_or_else(|| AppError::NotFound("nie ma takiego wydarzenia".to_string()))?;

    db::clear_user_unavailabilities(&conn, event_id, payload.user_id).await?;
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
    let conn = app_state.db.connect()?;
    let new_event = db::create_event(
        &conn,
        &payload.name,
        payload.description,
        payload.earliest,
        payload.latest,
    )
    .await?;
    Ok(Json(new_event))
}
