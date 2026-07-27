// Вставьте сюда объект конфигурации из Firebase Console:
// Project settings → General → Your apps → Web app → SDK setup and configuration.
// Эти значения идентифицируют проект, но безопасность обеспечивают правила базы данных.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://PASTE_DATABASE_NAME.REGION.firebasedatabase.app",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.length > 0 && !value.includes("PASTE_")
);
