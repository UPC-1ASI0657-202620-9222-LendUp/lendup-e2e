"""External-provider doubles loaded only by the local Compose entrypoint."""
import uvicorn

from app.application.services import analysis, incident
from app.domain.entities.analysis import AnalysisResult
from app.infrastructure.cloudinary import storage


class LocalCloudinary:
    def upload(self, data, mime, public_id, folder):
        resource, extension = ("video", "mp4") if mime.startswith("video/") else ("image", "jpg")
        return storage.Asset(public_id, f"https://res.cloudinary.com/lendup-e2e/{resource}/upload/{public_id}.{extension}")

    def delete(self, public_id, video):
        pass


class LocalGemini:
    async def compare(self, initial_url, final_url):
        return AnalysisResult(resumen="Comparación local de las fotografías.", diferencias_visibles=[],
                              limitaciones=["Resultado del proveedor simulado."], comparabilidad="MEDIA")


if __name__ == "__main__":
    storage.CloudinaryStorage = incident.CloudinaryStorage = LocalCloudinary
    analysis.GoogleAIAdapter = LocalGemini
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
