use crate::error::AppError;
use crate::models::{Event, TimeOfDay, User};
use chrono::{NaiveDate, NaiveDateTime};
use libsql::{params, Connection};
use nanoid::nanoid;
use std::collections::HashMap;

fn parse_date(s: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| AppError::BadRequest(format!("invalid date: {}", e)))
}

fn parse_datetime(s: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| AppError::BadRequest(format!("invalid datetime: {}", e)))
}

fn row_to_event(row: &libsql::Row) -> Result<Event, AppError> {
    let earliest_str: String = row.get(4)?;
    let latest_str: String = row.get(5)?;
    let created_at_str: String = row.get(6)?;

    Ok(Event {
        id: row.get(0)?,
        public_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get::<String>(3).ok(),
        earliest: parse_date(&earliest_str)?,
        latest: parse_date(&latest_str)?,
        created_at: parse_datetime(&created_at_str)?,
    })
}

pub async fn validate_user_exists(conn: &Connection, user_id: i64) -> Result<(), AppError> {
    let mut rows = conn
        .query("SELECT id FROM users WHERE id = ?1", params![user_id])
        .await?;
    rows.next()
        .await?
        .ok_or_else(|| AppError::NotFound("Uzytkownik o podanym ID nie istnieje.".to_string()))?;
    Ok(())
}

pub async fn find_user_by_name(conn: &Connection, name: &str) -> Result<Option<User>, AppError> {
    let mut rows = conn
        .query("SELECT id, name FROM users WHERE name = ?1", params![name])
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(User {
            id: row.get(0)?,
            name: row.get(1)?,
        })),
        None => Ok(None),
    }
}

pub async fn create_user(conn: &Connection, name: &str) -> Result<User, AppError> {
    let mut rows = conn
        .query(
            "INSERT INTO users (name) VALUES (?1) RETURNING id, name",
            params![name],
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| AppError::BadRequest("failed to create user".to_string()))?;
    Ok(User {
        id: row.get(0)?,
        name: row.get(1)?,
    })
}

pub async fn create_event(
    conn: &Connection,
    name: &str,
    description: Option<String>,
    earliest: NaiveDate,
    latest: NaiveDate,
) -> Result<Event, AppError> {
    let public_id = nanoid!(10);
    let desc_val = description
        .map(libsql::Value::Text)
        .unwrap_or(libsql::Value::Null);
    let mut rows = conn
        .query(
            "INSERT INTO events (public_id, name, description, earliest, latest) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *",
            vec![
                libsql::Value::Text(public_id),
                libsql::Value::Text(name.to_string()),
                desc_val,
                libsql::Value::Text(earliest.to_string()),
                libsql::Value::Text(latest.to_string()),
            ],
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| AppError::BadRequest("failed to create event".to_string()))?;
    row_to_event(&row)
}

pub async fn get_all_events(conn: &Connection) -> Result<Vec<Event>, AppError> {
    let mut rows = conn
        .query("SELECT * FROM events ORDER BY created_at DESC", ())
        .await?;
    let mut events = Vec::new();
    while let Some(row) = rows.next().await? {
        events.push(row_to_event(&row)?);
    }
    Ok(events)
}

pub async fn get_event_by_public_id(
    conn: &Connection,
    public_id: &str,
) -> Result<Option<Event>, AppError> {
    let mut rows = conn
        .query(
            "SELECT * FROM events WHERE public_id = ?1",
            params![public_id],
        )
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(row_to_event(&row)?)),
        None => Ok(None),
    }
}

pub async fn get_event_id_by_public_id(
    conn: &Connection,
    public_id: &str,
) -> Result<Option<i64>, AppError> {
    let mut rows = conn
        .query(
            "SELECT id FROM events WHERE public_id = ?1",
            params![public_id],
        )
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub async fn get_event_unavailability_details(
    conn: &Connection,
    event_id: i64,
) -> Result<HashMap<String, HashMap<String, String>>, AppError> {
    let mut rows = conn
        .query(
            "SELECT u.day, u.time_of_day, GROUP_CONCAT(us.name) as names
             FROM unavailabilities u
             JOIN users us ON u.user_id = us.id
             WHERE u.event_id = ?1
             GROUP BY u.day, u.time_of_day",
            params![event_id],
        )
        .await?;

    let mut details: HashMap<String, HashMap<String, String>> = HashMap::new();
    while let Some(row) = rows.next().await? {
        let day: String = row.get(0)?;
        let time_of_day: String = row.get(1)?;
        if let Ok(name_list) = row.get::<String>(2) {
            details
                .entry(day)
                .or_default()
                .insert(time_of_day, name_list);
        }
    }
    Ok(details)
}

pub async fn add_unavailability(
    conn: &Connection,
    event_id: i64,
    user_id: i64,
    start_date: NaiveDate,
    end_date: NaiveDate,
    times_of_day: Vec<TimeOfDay>,
) -> Result<(), AppError> {
    let tx = conn.transaction().await?;
    for day in start_date.iter_days().take_while(|d| d <= &end_date) {
        for time_of_day in &times_of_day {
            tx.execute(
                "INSERT OR IGNORE INTO unavailabilities (event_id, user_id, day, time_of_day) VALUES (?1, ?2, ?3, ?4)",
                params![event_id, user_id, day.to_string(), time_of_day.0.clone()],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn remove_unavailability(
    conn: &Connection,
    event_id: i64,
    user_id: i64,
    start_date: NaiveDate,
    end_date: NaiveDate,
    times_of_day: Vec<TimeOfDay>,
) -> Result<(), AppError> {
    let tx = conn.transaction().await?;
    for day in start_date.iter_days().take_while(|d| d <= &end_date) {
        for time_of_day in &times_of_day {
            tx.execute(
                "DELETE FROM unavailabilities WHERE event_id = ?1 AND user_id = ?2 AND day = ?3 AND time_of_day = ?4",
                params![event_id, user_id, day.to_string(), time_of_day.0.clone()],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn clear_user_unavailabilities(
    conn: &Connection,
    event_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM unavailabilities WHERE event_id = ?1 AND user_id = ?2",
        params![event_id, user_id],
    )
    .await?;
    Ok(())
}
