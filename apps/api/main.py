from fastapi import FastAPI
import uvicorn

app = FastAPI(title="Recipe AI Cloud API")

@app.get("/")
def read_root():
    return {"message": "Welcome to the Recipe AI Cloud API."}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
