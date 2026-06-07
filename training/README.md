# Training — Entrenamiento del Modelo de Segmentación de Tumores Pulmonares

Esta carpeta contiene los scripts para entrenar el modelo **SegResNet** con el dataset **MSD Task06_Lung** usando la Máquina Virtual de Google Cloud (`instance-20260504-231017`).

> El entrenamiento ocurre **100% aislado** del sistema de producción (API web). No modifica nada en Cloud Run.

---

## Archivos

| Archivo | Descripción |
|---|---|
| `train_lung_tumor_segresnet.py` | Script principal de entrenamiento |
| `setup_vm.sh` | Configura el entorno en la VM (instala dependencias) |

---

## Paso a Paso para Ejecutar en la VM de Google Cloud

### 1. Encender la Máquina Virtual
```bash
gcloud compute instances start instance-20260504-231017 \
  --zone us-central1-c \
  --project pulmoseg3d
```

### 2. Conectarse a la VM por SSH
```bash
gcloud compute ssh instance-20260504-231017 \
  --zone us-central1-c \
  --project pulmoseg3d
```

### 3. Copiar los scripts a la VM
En tu computador local (PowerShell):
```powershell
gcloud compute scp training/setup_vm.sh training/train_lung_tumor_segresnet.py `
  instance-20260504-231017:/home/ `
  --zone us-central1-c `
  --project pulmoseg3d
```

### 4. Configurar el entorno (solo la primera vez)
Dentro de la VM:
```bash
chmod +x /home/setup_vm.sh
/home/setup_vm.sh
```
Esto instala PyTorch, MONAI y descarga el dataset Task06_Lung desde GCS.
**Tiempo estimado: 5-10 minutos**

### 5. Iniciar el entrenamiento
```bash
# En primer plano (ver logs en tiempo real):
python3 /home/train_lung_tumor_segresnet.py \
  --dataset_dir /home/datasets/Task06_Lung

# En segundo plano (recomendado: la sesión SSH puede cerrarse):
nohup python3 /home/train_lung_tumor_segresnet.py \
  --dataset_dir /home/datasets/Task06_Lung \
  > /home/training_output/lung_tumor_segresnet_v1/nohup.log 2>&1 &
echo "PID del proceso: $!"
```

### 6. Monitorear el Progreso (desde otra terminal)
```bash
tail -f /home/training_output/lung_tumor_segresnet_v1/training.log
```

---

## Configuración del Entrenamiento

| Parámetro | Valor |
|---|---|
| Arquitectura | SegResNet |
| Dataset | MSD Task06_Lung (63 casos de entrenamiento) |
| Clases | 2: `background` (0) y `cancer` (1) |
| Epochs | 300 |
| Patch Size | 96 × 96 × 96 |
| Batch Size | 2 |
| Optimizer | AdamW (lr=1e-4, weight_decay=1e-5) |
| Scheduler | CosineAnnealing (hasta 1e-6) |
| Loss | DiceCE Loss |
| Val Split | 80% train / 20% val (split fijo, fold 1/1) |
| Val Interval | Cada 10 epochs |
| Output | `gs://pulmoseg-models/trained/lung_tumor_segresnet_v1/model.pt` |

---

## Estimación de Tiempos (GPU NVIDIA T4 - 16GB)

| Fase | Duración estimada |
|---|---|
| Configurar VM + instalar dependencias | ~10 minutos |
| Caché del dataset en RAM | ~10-20 minutos |
| Entrenamiento completo (300 epochs) | **~24 a 36 horas** |
| Subida del modelo a GCS | ~1 minuto |

> **Tip:** Usa `nohup` para que el entrenamiento siga corriendo incluso si cierras la terminal SSH.

---

## Resultado Esperado

Al finalizar, el script imprimirá en consola:
```
================================================================
  RESULTADO FINAL DEL ENTRENAMIENTO
================================================================
  Dice Score de Validación : 0.67  (67.00%)
  Mejor época              : 280 de 300
  Tiempo total             : 28.4 horas
  Modelo guardado en       : gs://pulmoseg-models/trained/lung_tumor_segresnet_v1/model.pt
================================================================
```

> Un **Dice > 0.60** en Task06_Lung es considerado un resultado aceptable para tumores pulmonares (la tarea es difícil por la variabilidad en tamaño y forma).

---

## Paso Final: Integrar el Modelo al Sistema de Producción

Una vez que el modelo esté en GCS, **apaga la VM** para no seguir siendo cobrado:
```bash
gcloud compute instances stop instance-20260504-231017 \
  --zone us-central1-c \
  --project pulmoseg3d
```

Luego, actualiza el archivo `worker/pipeline/manager.py` para que apunte al nuevo modelo de tumores. Con ayuda de Vibe Coding, esto toma menos de 5 minutos.
