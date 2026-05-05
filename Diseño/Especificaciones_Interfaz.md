Contexto del Proyecto:
Interfaz profesional para un sistema de IA de segmentación 3D de nódulos pulmonares. El usuario es un radiólogo o investigador que sube estudios CT en formato DICOM para obtener una cuantificación volumétrica automática.

Stack Tecnológico Requerido:

Framework: React 18+ (Vite o Next.js).

Estilos: Tailwind CSS.

Componentes: Shadcn/ui (Card, Button, Progress, Table, Badge, Toast).

Iconografía: Lucide-react.

Estructura de la Interfaz (Layout):

Sidebar (Izquierda): Dashboard, Nueva Segmentación, Historial de Estudios, Configuración del Modelo (nnU-Net v2).

Main Content (Centro):

Header: Título del proyecto "PulmoSeg 3D", estado de conexión con la API FastAPI (indicador visual verde/rojo).

Sección de Carga: Un componente "Dropzone" que soporte la selección de carpetas completas (webkitdirectory). Debe mostrar el nombre de la carpeta y conteo de archivos .dcm.

Monitor de Tareas: Una lista de "Jobs" activos. Cada Job debe tener: ID, Nombre del Paciente (extraído o simulado), una barra de progreso animada y un Badge de estado (QUEUED, PROCESSING, COMPLETED, FAILED).

Panel de Resultados (Vista Previa): Un área que se active al finalizar el proceso. Debe mostrar:

Métricas: Volumen total del nódulo (mL), Diámetro mayor, Densidad promedio (HU).

Visualizador: Un contenedor oscuro de 3 paneles (Axial, Coronal, Sagital) simulando la visualización de 3D Slicer.

Lógica de Negocio (Backend Integration):

Endpoint 1: POST /upload -> Envía los archivos y recibe un job_id.

Endpoint 2: GET /status/{job_id} -> Polling constante cada 3 segundos para actualizar la UI.

Endpoint 3: GET /results/{job_id} -> Recupera el JSON con las métricas finales.

Estética Deseada:

Look & Feel: "Enterprise AI" / "Medical Grade".

Paleta de colores: Fondos Slate-950 (Modo oscuro), acentos en Cyan-500 o Blue-600.

Tipografía: Inter o Geist (limpia y técnica).