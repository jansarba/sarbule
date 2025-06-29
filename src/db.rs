use crate::error::AppError;
use crate::models::{Event, TimeOfDay, User};
use chrono::NaiveDate;
use nanoid::nanoid;
use sqlx::SqlitePool;
use std::collections::HashMap;

pub async fn find_user_by_name(pool: &SqlitePool, name: &str) -> Result<Option<User>, AppError> {
    sqlx::query_as("SELECT id, name FROM users WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(AppError::from)
}

pub async fn create_user(pool: &SqlitePool, name: &str) -> Result<User, AppError> {
    let user_id = sqlx::query("INSERT INTO users (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    Ok(User {
        id: user_id,
        name: name.to_string(),
    })
}

pub async fn create_event(
    pool: &SqlitePool,
    name: &str,
    description: Option<String>,
    earliest: NaiveDate,
    latest: NaiveDate,
) -> Result<Event, AppError> {
    let public_id = nanoid!(10);
    let event = sqlx::query_as(
        "INSERT INTO events (public_id, name, description, earliest, latest) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(public_id)
    .bind(name)
    .bind(description)
    .bind(earliest)
    .bind(latest)
    .fetch_one(pool)
    .await?;
    Ok(event)
}

pub async fn get_all_events(pool: &SqlitePool) -> Result<Vec<Event>, AppError> {
    sqlx::query_as("SELECT * FROM events ORDER BY created_at DESC")
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
}

pub async fn get_event_unavailability_details(
    pool: &SqlitePool,
    event_id: i64,
) -> Result<HashMap<String, HashMap<String, String>>, AppError> {
    let rows: Vec<(NaiveDate, TimeOfDay, Option<String>)> = sqlx::query_as(
        "SELECT u.day, u.time_of_day, GROUP_CONCAT(us.name) as names 
         FROM unavailabilities u 
         JOIN users us ON u.user_id = us.id 
         WHERE u.event_id = ? 
         GROUP BY u.day, u.time_of_day",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;

    let mut details: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (day, time_of_day, names) in rows {
        if let Some(name_list) = names {
            details
                .entry(day.to_string())
                .or_default()
                .insert(time_of_day.0, name_list);
        }
    }
    Ok(details)
}

pub async fn add_unavailability(
    pool: &SqlitePool,
    event_id: i64,
    user_id: i64,
    start_date: NaiveDate,
    end_date: NaiveDate,
    times_of_day: Vec<TimeOfDay>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    for day in start_date.iter_days().take_while(|d| d <= &end_date) {
        for time_of_day in &times_of_day {
            sqlx::query(
                "INSERT OR IGNORE INTO unavailabilities (event_id, user_id, day, time_of_day) VALUES (?, ?, ?, ?)",
            )
            .bind(event_id)
            .bind(user_id)
            .bind(day)
            .bind(&time_of_day.0)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn remove_unavailability(
    pool: &SqlitePool,
    event_id: i64,
    user_id: i64,
    start_date: NaiveDate,
    end_date: NaiveDate,
    times_of_day: Vec<TimeOfDay>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    for day in start_date.iter_days().take_while(|d| d <= &end_date) {
        for time_of_day in &times_of_day {
            sqlx::query(
                "DELETE FROM unavailabilities WHERE event_id = ? AND user_id = ? AND day = ? AND time_of_day = ?",
            )
            .bind(event_id)
            .bind(user_id)
            .bind(day)
            .bind(&time_of_day.0)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn clear_user_unavailabilities(
    pool: &SqlitePool,
    event_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM unavailabilities WHERE event_id = ? AND user_id = ?")
        .bind(event_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}