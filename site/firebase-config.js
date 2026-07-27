// Firebase Web App configuration for project Pylt.
export const firebaseConfig = {
  apiKey: "AIzaSyArRkd5H7Ivxm2ajDwOwL9xWnaqb0JaeXM",
  authDomain: "pylt-613bc.firebaseapp.com",
  databaseURL: "https://pylt-613bc-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "pylt-613bc",
  storageBucket: "pylt-613bc.firebasestorage.app",
  messagingSenderId: "416587042132",
  appId: "1:416587042132:web:c20942d01397a42c61ccc1"
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.length > 0 && !value.includes("PASTE_")
);
