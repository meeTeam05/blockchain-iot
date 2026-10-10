# ai_model

`gas_ews_int8.tflite`: on-device early-warning model for CO and NO2 (1D-CNN, 12,186 parameters, 20,896 B, full INT8). It is embedded into the firmware at build time by [`iot_code/components/core/ai/CMakeLists.txt`](../iot_code/components/core/ai/CMakeLists.txt) when `CONFIG_SA_ENABLE_AI` is on.

Inference, thresholds and the safety logic around the model are in [`iot_code/components/core/ai/`](../iot_code/components/core/ai). Model description and evaluation: [`docs/reference/AI.md`](../docs/reference/AI.md) and [`REVIEW_MODEL.md`](../iot_code/components/core/ai/REVIEW_MODEL.md).

The training pipeline is not in this repository. The file is exported by `gas_ews.export_firmware` of the separate `ungdungdidong` project (see section 6 of the component README).
