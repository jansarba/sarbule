use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct Event {
    pub id: i64,
    pub public_id: String,
    pub name: String,
    pub description: Option<String>,
    pub earliest: NaiveDate,
    pub latest: NaiveDate,
    #[serde(skip_serializing)]
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, PartialEq, Eq, Hash, Clone, Serialize, Deserialize)]
pub struct TimeOfDay(pub String);
