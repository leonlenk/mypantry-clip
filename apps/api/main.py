from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.utils.logger import setup_logging
from src.config import settings
from src.routers import extract, substitute, auth, sync
from loguru import logger
import uvicorn

setup_logging()

app = FastAPI(title="MyPantry Cloud API")

@app.on_event("startup")
def startup_event():
    logger.info(f"CORS allowed origin: chrome-extension://{settings.extension_id}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"chrome-extension://{settings.extension_id}",
        "chrome-extension://gmbkgpocgmmcomccenimchgdbmofekno",
        "http://localhost",
        "http://127.0.0.1",
        "http://localhost:8000",
        "http://127.0.0.1:8000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extract.router)
app.include_router(substitute.router)
app.include_router(sync.router)
app.include_router(auth.router, prefix="/oauth", tags=["oauth"])

@app.get("/")
def read_root():
    return {"message": "Welcome to the MyPantry Cloud API."}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
