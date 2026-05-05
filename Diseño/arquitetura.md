# Especificaciones Técnicas de Arquitectura - PulmoSeg 3D

## 1. Diagrama de Componentes (Infraestructura GCP)
Este diagrama define la separación de servicios y la red.
\```mermaid
flowchart TB
 subgraph subGraph0["Capa de Entrada / Frontend"]
        F["Módulo Externo / Frontend"]
  end
 subgraph subGraph1["Almacenamiento y Modelos (GCP)"]
        GCS_IN[("GCS Bucket: inputs")]
        GCS_OUT[("GCS Bucket: outputs")]
        GCS_MOD[("GCS Bucket: Model Weights")]
        DB[("Firestore: Job Status")]
  end
 subgraph subGraph2["Orquestación (Cloud Run - Async)"]
        API["FastAPI Gateway"]
  end
 subgraph subGraph3["Pipeline Secuencial (Lógica Médica)"]
        ING["1. DICOM Ingestion"]
        VC["2. Volumetric Converter"]
        ROI["3. ROI Extractor"]
        MT["4. MONAI Transforms"]
        INF["5. SegResNet Inferer"]
        PP["6. Postprocesamiento"]
  end
 subgraph subGraph4["Motor de Inferencia (Vertex AI - GPU)"]
        ML{"Worker ML\nPyTorch + MONAI"}
        subGraph3
  end
 subgraph Observabilidad["Observabilidad"]
        LOG["Cloud Logging / Monitoring"]
  end
    ING --> VC
    VC --> ROI
    ROI --> MT
    MT --> INF
    INF --> PP
    F -- "1. Solicita Signed URL" --> API
    API -- "2. POST /segment" --> F
    F == "3. Sube DICOM" ==> GCS_IN
    API -- "4. Encola Trabajo" --> ML
    ML -. "5. Carga Pesos" .-> GCS_MOD
    ML -. "6. Descarga DICOM" .-> GCS_IN
    ML --> ING
    PP == "7. Guarda NIfTI" ==> GCS_OUT
    PP -- "8. Actualiza Status" --> DB
    F -. "9. Polling Status" .-> API
    API -. "10. Retorna JSON" .-> F
    API -.-> LOG
    ML -.-> LOG
    n1["Text Block"]

    n1@{ shape: text}
     F:::client
     GCS_IN:::storage
     GCS_OUT:::storage
     GCS_MOD:::storage
     DB:::storage
     API:::api
     ML:::compute
     ING:::process
     VC:::process
     ROI:::process
     MT:::process
     INF:::process
     PP:::process
     LOG:::monitor
    classDef client fill:#3b3b3b,stroke:#ffffff,stroke-width:2px,color:#ffffff,font-size:23px
    classDef storage fill:#1e88e5,stroke:#0d47a1,stroke-width:2px,color:#ffffff,font-size:20px
    classDef api fill:#f57c00,stroke:#e65100,stroke-width:2px,color:#ffffff,font-size:22px
    classDef compute fill:#43a047,stroke:#1b5e20,stroke-width:2px,color:#ffffff,font-size:22px,font-weight:bold
    classDef process fill:#2e7d32,stroke:#1b5e20,stroke-width:1px,color:#ffffff,font-size:20px
    classDef monitor fill:#1565c0,stroke:#0d47a1,stroke-width:2px,color:#ffffff,font-size:20x
\```

## 2. Diagrama de Flujo de Datos (Pipeline Médico)
Este diagrama define la lógica secuencial desde el DICOM hasta el volumen.
\```mermaid
graph TD
    %% Entradas
    Req[Petición API: StudyUID + ROI Coords] --> FastAPI
    
    %% Ingesta y Preparación
    FastAPI --> FetchDICOM[Descarga DICOM desde GCS]
    FetchDICOM --> ExtractMeta[Extracción de Metadatos: pydicom]
    ExtractMeta --> ConvertNIfTI[Conversión a Volúmen NIfTI: SimpleITK/nibabel]
    
    %% Pipeline de Optimización y MONAI
    ConvertNIfTI --> CropROI[Recorte de ROI basado en coordenadas]
    CropROI --> Resample[Resampling Isotrópico: MONAI]
    Resample --> Normalize[Normalización de Intensidad Hounsfield]
    
    %% Inferencia y Postprocesamiento
    Normalize --> Inference[Inferencia PyTorch 3D U-Net en GPU]
    Inference --> PostProcess[Postprocesamiento: Umbralización / Componentes Conectados]
    
    %% Cuantificación
    PostProcess --> CalcVolume[Cálculo Volumétrico exacto]
    CalcVolume --> Output[Generación JSON + Máscara NIfTI en GCS]
    Output --> FastAPI
\```

## 3. Diagrama de Secuencia (Interacción Asíncrona)
\```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente (Frontend)
    participant A as API Gateway / Backend
    participant Q as Cola de Mensajes (RabbitMQ/Kafka)
    participant W as Worker (Procesador)
    participant DB as Base de Datos

    Note over C, A: Inicio de petición asíncrona
    C->>A: POST /ejecutar-tarea-pesada
    A->>Q: Publicar evento "TareaPendiente"
    Q-->>A: Confirmación de recepción (ACK)
    
    Note right of A: El API no espera al Worker
    A-->>C: 202 Accepted (Tracking ID)
    
    rect rgb(240, 240, 240)
        Note over Q, DB: Procesamiento en Segundo Plano (Background)
        W->>Q: Consume evento "TareaPendiente"
        Q-->>W: Datos de la tarea
        W->>W: Procesamiento intensivo de datos
        W->>DB: Guardar resultado final
        W-->>C: Notificación (vía Webhook o WebSocket)
    end
\```

## 4. Diagrama de Estados (Ciclo de Vida del Job)
\```mermaid
stateDiagram-v2
    %% Estilos
    classDef success fill:#2e7d32,color:white,stroke:#1b5e20
    classDef error fill:#c62828,color:white,stroke:#b71c1c
    classDef warning fill:#f9a825,color:black,stroke:#f57f17
    classDef processing fill:#1565c0,color:white,stroke:#0d47a1

    [*] --> QUEUED : 1. API POST /segment
    
    QUEUED --> PROCESSING : 2. Worker consume de Pub/Sub
    
    state PROCESSING {
        direction TB
        [*] --> Descarga_DICOM
        Descarga_DICOM --> MONAI_Crop_Resample : Éxito
        MONAI_Crop_Resample --> Inferencia_UNet : Éxito
        Inferencia_UNet --> Calculo_Volumetrico : Éxito
        Calculo_Volumetrico --> [*] : Éxito
        
        %% Casos de fallo interno
        Descarga_DICOM --> Falla_Interna : GCS Inaccesible / DICOM Corrupto
        MONAI_Crop_Resample --> Falla_Interna : Coordenadas ROI inválidas
        Inferencia_UNet --> Falla_Interna : GPU Out of Memory (OOM)
    }
    
    PROCESSING --> COMPLETED:::success : Proceso exitoso
    PROCESSING --> EVALUACION_ERROR:::warning : Ocurre Falla_Interna
    
    state EVALUACION_ERROR {
        [*] --> Clasificar_Error
        Clasificar_Error --> ES_TRANSITORIO : Timeout API, Falla Red GCS
        Clasificar_Error --> ES_FATAL : DICOM inválido, GPU OOM persistente
    }
    
    ES_TRANSITORIO --> RETRY : Aplicar Backoff Exponencial
    RETRY --> QUEUED : Intentos < 3
    RETRY --> FAILED:::error : Intentos >= 3
    
    ES_FATAL --> FAILED:::error
    
    FAILED --> DLQ : Enviar payload a Dead Letter Queue
    FAILED --> Notificacion_Cliente : Actualizar Firestore a FAILED\n+ Webhook
    COMPLETED --> Notificacion_Cliente : Actualizar Firestore a COMPLETED\n+ Webhook
    
    Notificacion_Cliente --> [*]
  
\```