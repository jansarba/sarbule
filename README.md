# sarbule - schedule unavailability app for my friend group

I have made this app to solve a simple problem - it's tough figuring out when each of my friends may be unavailable when planning for my birthday party. I ended up with a rather simple, robust, scalable and universal solution!
As of right now, I trust my friends enough not to have implemented a password system; it can be done quite easily though - just add a password hash field to the users table and phone in some simple JWT functionality.

## Tech Stack

### Backend
*   **Rust**: The programming language for all server-side logic.
*   **Axum**: A minimalist web framework for building APIs.
*   **Tokio**: The asynchronous runtime for Rust applications.
*   **SQLx**: A modern, asynchronous SQL toolkit for Rust with compile-time query verification.
*   **Serde**: A framework for serializing and deserializing Rust data structures (primarily to/from JSON).

### Frontend
*   **HTML5 / CSS3 / JavaScript (ES6+)**: Core web technologies.
*   **jQuery**: A utility library for DOM manipulation and AJAX requests.
*   **CSS Flexbox & Grid**: Used for creating the responsive calendar layout. No Tailwind this time!

### Database
*   **SQLite**: A lightweight, file-based database.

### Infrastructure & Deployment
*   **Docker**: Application containerization for easy deployment.
*   **Fly.io**: The platform for hosting and running the containerized application.

---

## Running Locally

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <project-directory>
    ```

2.  **Create a `.env` file** in the project root and add the environment variable pointing to a local database file:
    ```
    DATABASE_URL="sqlite:sarbule_local.db"
    ```

3.  **Run the application** using Cargo:
    ```bash
    cargo run
    ```
    Cargo will automatically download dependencies and compile the project. The application will be available at `http://localhost:3000`.

## Deploying to Fly.io

1.  **Set the database secret** to point to a persistent volume:
    ```bash
    fly secrets set DATABASE_URL="sqlite:///data/sarbule.db"
    ```

2.  **Deploy the application:**
    ```bash
    fly deploy
    ```
