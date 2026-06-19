---
title: Smart Vision Workbench：基于 Qt 6 插件架构的计算机视觉工作台
published: 2026-06-19
description: '从零设计插件式图像处理应用，涵盖 Qt 插件系统、异步处理管线、动态参数 UI 生成与实时摄像头处理'
image: ''
tags: [Qt, C++, OpenCV, 插件架构, 计算机视觉]
category: 项目展示
draft: false
lang: zh
---

## 项目概述

Smart Vision Workbench 是一款专业级图像处理工作台，采用 Qt 6 + OpenCV 构建，核心设计目标是**插件化的处理管线**——所有图像处理算法以插件形式存在，主程序通过 `QPluginLoader` 动态发现和加载，用户可自由组合处理步骤形成处理链。项目实现了从架构设计到 UI 交互的完整闭环，涵盖 Qt 插件系统、多线程异步处理、动态 UI 生成、实时摄像头捕获等技术点。

## 技术栈

- **框架**：Qt 6.8 / C++17
- **构建**：CMake 3.16+，多目标组织
- **图像处理**：OpenCV 4.x
- **并发**：QtConcurrent + QThread + QAtomicInt
- **插件**：QPluginLoader + Qt 元对象系统
- **序列化**：QJsonDocument 项目持久化

## 架构设计

### 整体分层

```
┌─────────────────────────────────────────┐
│              UI Layer                    │
│  ImageCanvas  ComparisonView  Panels     │
├─────────────────────────────────────────┤
│            Application Layer             │
│  MainWindow  Application  ProjectModel   │
├─────────────────────────────────────────┤
│             Core Layer                   │
│  ProcessingPipeline  PluginManager       │
│  IImageProcessor  IPluginFactory         │
├─────────────────────────────────────────┤
│            Capture Layer                 │
│  CameraDevice  FrameGrabber              │
│  ImageFileSource                         │
├─────────────────────────────────────────┤
│           Plugin Layer (DLL)             │
│  edge_detection  filtering  morphology   │
│  threshold  face_detection  ...          │
└─────────────────────────────────────────┘
```

这种分层确保了核心逻辑与 UI 解耦，插件与宿主完全隔离，每一层都可以独立测试和替换。

## 核心技术实现

### 1. 插件架构：QPluginLoader 动态加载

插件系统的核心是 `IImageProcessor` 接口和 `IPluginFactory` 工厂：

```cpp
// 核心处理器接口 —— 所有算法必须实现
class IImageProcessor {
public:
    virtual ~IImageProcessor() = default;

    // 身份
    virtual PluginMetadata metadata() const = 0;

    // 参数描述（驱动 UI 自动生成）
    virtual QList<ParameterDescriptor> parameterDescriptors() const = 0;
    virtual void setParameter(const QString& id, const QVariant& value) = 0;
    virtual QVariant parameter(const QString& id) const = 0;
    virtual void resetParameters() = 0;

    // 处理（必须线程安全，不可修改输入）
    virtual ImageData process(const ImageData& input) = 0;

    // 序列化（项目保存/加载）
    virtual QJsonObject parameterState() const = 0;
    virtual void setParameterState(const QJsonObject& state) = 0;
};

#define IImageProcessor_IID "org.svw.IImageProcessor"
Q_DECLARE_INTERFACE(IImageProcessor, IImageProcessor_IID)
```

`PluginManager` 在运行时扫描插件目录，通过 `QPluginLoader` 加载 DLL，利用 Qt 元对象系统的 `qobject_cast` 安全转型：

```cpp
void PluginManager::scanPlugins(const QString& pluginDir) {
    QDir dir(pluginDir);
    const QStringList filters =
    #ifdef Q_OS_WIN
        QStringList("*.dll");
    #elif defined(Q_OS_MAC)
        QStringList("*.dylib");
    #else
        QStringList("*.so");
    #endif

    for (const QFileInfo& fi : dir.entryInfoList(filters, QDir::Files)) {
        QPluginLoader loader(fi.absoluteFilePath());
        QObject* pluginObj = loader.instance();

        // 优先尝试 IPluginFactory（多处理器插件）
        IPluginFactory* factory = qobject_cast<IPluginFactory*>(pluginObj);
        if (factory) {
            // 从工厂创建临时实例获取元数据
            QList<IImageProcessor*> tempProcs = factory->createProcessors();
            for (IImageProcessor* proc : tempProcs) {
                m_metadata[proc->metadata().id] = proc->metadata();
                delete proc;  // 临时实例，仅用于读取元数据
            }
        }
    }
}
```

**设计亮点**：支持两种插件形态——单处理器插件（直接实现 `IImageProcessor`）和多处理器工厂插件（实现 `IPluginFactory`，如 FaceDetection 同时提供 Haar 和 DNN 两种检测器）。这让插件开发者可以按需选择粒度。

### 2. 异步处理管线：帧丢弃与线程安全

`ProcessingPipeline` 是整个应用的引擎，它将多个 `IImageProcessor` 串联执行，并实现了关键的性能优化：

```cpp
void ProcessingPipeline::processFrame(const ImageData& input) {
    // 帧丢弃策略：如果上一帧还在处理，跳过当前帧
    if (m_processing.testAndSetRelaxed(0, 1)) {
        m_lastInput = input;
        // 异步执行管线
        QtConcurrent::run([this, input]() {
            ImageData result = runPipeline(input);
            m_processing.storeRelaxed(0);
            emit pipelineFinished(result);
        });
    } else {
        // 丢弃当前帧，但记录为最新输入（下次处理时使用）
        m_lastInput = input;
        m_frameDropped.storeRelaxed(1);
    }
}
```

**关键设计决策**：

| 问题 | 方案 |
|-----|------|
| UI 卡顿 | `QtConcurrent::run` 在线程池中执行 |
| 帧堆积 | `QAtomicInt` 实现无锁帧丢弃 |
| 数据竞争 | `QMutex` 保护管线节点列表 |
| 参数实时调整 | `reprocess()` 用最新输入重新处理 |

`runPipeline` 内部还记录了每个处理器的耗时，通过 `processorTimeMs` 信号实时反馈到状态栏，方便性能分析。

### 3. 动态参数 UI 生成

这是本项目最有意思的设计之一——**插件无需编写任何 UI 代码**。`ParameterPanel` 根据 `ParameterDescriptor` 元数据自动生成对应的控件：

```cpp
void ParameterPanel::createWidgetForDescriptor(
    const ParameterDescriptor& desc, QVBoxLayout* layout)
{
    // 枚举类型 → QComboBox
    if (!desc.enumValues.isEmpty()) {
        QComboBox* combo = new QComboBox;
        for (const auto& val : desc.enumValues)
            combo->addItem(val.toString());
        // ...
    }
    // 布尔类型 → QCheckBox
    else if (desc.defaultValue.typeId() == QMetaType::Bool) {
        QCheckBox* check = new QCheckBox(desc.displayName);
        // ...
    }
    // 整数类型 → QSpinBox
    else if (desc.defaultValue.typeId() == QMetaType::Int) {
        QSpinBox* spin = new QSpinBox;
        spin->setRange(desc.minValue.toInt(), desc.maxValue.toInt());
        spin->setSingleStep(desc.stepValue.toInt());
        // ...
    }
    // 浮点类型 → QDoubleSpinBox
    else if (desc.defaultValue.typeId() == QMetaType::Double) {
        QDoubleSpinBox* spin = new QDoubleSpinBox;
        spin->setRange(desc.minValue.toDouble(), desc.maxValue.toDouble());
        // ...
    }
}
```

插件只需声明参数描述，例如 Canny 边缘检测器：

```cpp
QList<ParameterDescriptor> CannyProcessor::parameterDescriptors() const {
    return {
        ParameterDescriptor::doubleParam(
            "threshold1", "Lower Threshold",
            80.0, 0.0, 500.0, 1.0, {}, "Lower threshold for hysteresis"),
        ParameterDescriptor::doubleParam(
            "threshold2", "Upper Threshold",
            200.0, 0.0, 500.0, 1.0, {}, "Upper threshold for hysteresis"),
        ParameterDescriptor::intParam(
            "apertureSize", "Aperture Size",
            3, 3, 7, 2, {}, "Sobel operator aperture size"),
        ParameterDescriptor::boolParam(
            "L2gradient", "Use L2 Gradient", false,
            {}, "Use L2 norm instead of L1"),
    };
}
```

主程序自动生成带分组、Tooltip、范围限制的参数面板。新增一个处理器，零行 UI 代码即可拥有完整的参数调节界面。

### 4. 实时摄像头处理

摄像头模块通过 `QThread` 实现独立采集循环，结合管线帧丢弃策略实现实时处理：

```cpp
void CameraDevice::captureLoop() {
    m_capture.open(m_deviceIndex, cv::CAP_DSHOW);
    m_capture.set(cv::CAP_PROP_FRAME_WIDTH, 1280);
    m_capture.set(cv::CAP_PROP_FRAME_HEIGHT, 720);

    cv::Mat frame;
    while (m_running.loadRelaxed()) {
        if (!m_capture.read(frame) || frame.empty()) {
            QThread::msleep(33);
            continue;
        }
        emit frameCaptured(frame);  // 通过信号发送到主线程
        QThread::msleep(10);        // 目标 ~30fps
    }
}
```

信号链路：`CameraDevice::frameCaptured` → `FrameGrabber::onFrameCaptured`（转为 `ImageData`）→ `ProcessingPipeline::processFrame`（异步处理）→ `pipelineFinished`（结果显示）。

跨线程通信全部使用 `Qt::QueuedConnection`，确保线程安全。

### 5. 对比视图

`ComparisonView` 提供三种对比模式：

- **SideBySide**：并排对比，可拖拽 QSplitter 调整比例
- **Overlay**：叠加滑动对比，拖拽红色分割线查看前后
- **Diff**：差异图，使用 `cv::absdiff` + 增益放大显示像素级差异

```cpp
QImage ComparisonView::computeDiffImage(const QImage& before, const QImage& after) const {
    cv::Mat beforeMat = CvMatToQImage::fromQImage(before);
    cv::Mat afterMat = CvMatToQImage::fromQImage(after);
    cv::Mat diff;
    cv::absdiff(beforeMat, afterMat, diff);
    // 放大差异以便观察
    diff.convertTo(amplified, -1, 3.0, 0);
    return CvMatToQImage::convert(amplified);
}
```

### 6. 项目持久化

`ProjectModel` 将管线状态序列化为 JSON，实现工作状态的保存与恢复：

```json
{
  "version": "1.0",
  "imagePath": "C:/photos/test.png",
  "pipeline": {
    "nodes": [
      {
        "processorId": "org.svw.edge_detection.canny",
        "enabled": true,
        "parameters": {
          "threshold1": 80.0,
          "threshold2": 200.0,
          "apertureSize": 3,
          "L2gradient": false
        }
      }
    ]
  }
}
```

## 插件生态

目前已实现 8 个插件类别、20 个处理器，覆盖图像处理主要领域。每个处理器都实现了 `IImageProcessor` 接口，支持参数序列化/反序列化（JSON），可在流水线中按顺序串联执行。下面逐一详细介绍。

### 🎨 Color Conversion — 颜色转换

#### Grayscale — 灰度转换

将彩色图像转换为灰度图像。3 通道 BGR → 灰度，4 通道 BGRA → 灰度，已经是灰度则直接克隆。这是图像处理中最基础的操作，几乎所有后续算法（边缘检测、阈值分割等）都需要先转灰度。

- **参数**：无
- **底层调用**：`cv::cvtColor(..., COLOR_BGR2GRAY / COLOR_BGRA2GRAY)`

#### HSV Conversion — HSV 色彩空间转换

将图像从 BGR 色彩空间转换到 HSV 色彩空间。HSV 空间中 H=色相、S=饱和度、V=亮度，便于进行颜色分割和筛选——例如提取特定颜色的物体，在 HSV 空间中只需设定 H 通道范围即可，比在 BGR 空间中操作直观得多。

- **参数**：无
- **底层调用**：`cv::cvtColor(..., COLOR_BGR2HSV)`

### 🔍 Edge Detection — 边缘检测

#### Canny Edge Detection — Canny 边缘检测

使用 Canny 算法检测图像中的边缘，是最常用、效果最好的边缘检测方法。算法流程：先转灰度 → Sobel 计算梯度 → 非极大值抑制 → 双阈值滞后处理。双阈值机制是 Canny 的核心：高于高阈值的像素一定是边缘，低于低阈值的一定不是，介于两者之间的只有在与确定边缘相连时才保留。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Lower Threshold | 滞后处理的低阈值 | 0~500 | 50 |
| Upper Threshold | 滞后处理的高阈值 | 0~500 | 150 |
| Aperture Size | Sobel 算子孔径大小 | 3/5/7 | 3 |
| Use L2 Gradient | 是否使用 L2 范数计算梯度 | true/false | false |

#### Sobel Edge Detection — Sobel 边缘检测

使用 Sobel 算子计算图像的 X/Y 方向导数来检测边缘。Sobel 是一阶微分算子，通过两个 3×3 卷积核分别计算水平和垂直方向的梯度。可分别控制 X 和 Y 方向的导数阶数——例如只设 dx=1, dy=0 可单独提取垂直边缘。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Derivative X order | X 方向导数阶数 | 0~2 | 1 |
| Derivative Y order | Y 方向导数阶数 | 0~2 | 1 |
| Kernel Size | Sobel 核大小 | 1/3/5/7 | 3 |
| Scale | 缩放因子 | 0.1~10.0 | 1.0 |

#### Laplacian Edge Detection — 拉普拉斯边缘检测

使用拉普拉斯算子（二阶导数）检测边缘。与 Sobel 的一阶导数不同，拉普拉斯对灰度变化更敏感，能检测到更细微的边缘，但对噪声也更敏感，通常需要先做高斯模糊降噪再使用。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size | 拉普拉斯核大小 | 1/3/5/7 | 3 |
| Scale | 缩放因子 | 0.1~10.0 | 1.0 |

### ✂️ Threshold — 阈值处理

#### Binary Threshold — 二值阈值

对图像进行手动阈值二值化处理。像素值大于阈值的设为最大值，小于的设为 0（或反之）。支持 5 种阈值类型：Binary（标准二值化）、Binary Inv（反转二值化）、Trunc（截断）、To Zero（低于阈值置零）、To Zero Inv（高于阈值置零）。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Threshold Value | 阈值 | 0~255 | 128 |
| Max Value | 最大值 | 0~255 | 255 |
| Threshold Type | 阈值类型 | Binary / Binary Inv / Trunc / To Zero / To Zero Inv | Binary |

#### Adaptive Threshold — 自适应阈值

根据每个像素周围的局部区域动态计算阈值，适合光照不均匀的图像。例如一张从窗户射入阳光的桌面照片，左侧亮右侧暗，用全局阈值无法同时处理好两侧，而自适应阈值可以分别适应不同区域的光照条件。支持两种自适应方法：Gaussian（加权高斯窗口）和 Mean（均值窗口）。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Max Value | 最大值 | 0~255 | 255 |
| Adaptive Method | 自适应方法 | Gaussian / Mean | Gaussian |
| Threshold Type | 阈值类型 | Binary / Binary Inv | Binary |
| Block Size | 局部块大小（奇数） | 3~99 | 11 |
| Constant C | 常数偏移 | -50~50 | 2.0 |

#### Otsu Threshold — 大津阈值

使用 Otsu 算法自动计算最佳阈值，无需手动设定。算法基于图像直方图的双峰特性，自动寻找使前景和背景类间方差最大的阈值。特别适合直方图呈明显双峰分布的图像（如文档扫描、细胞图像）。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Max Value | 最大值 | 0~255 | 255 |

### 🌫️ Filtering — 滤波

#### Gaussian Blur — 高斯模糊

使用高斯核进行图像模糊，是最常用的平滑滤波器。高斯核的权重按二维高斯函数分布，中心权重最大，向外递减，使得模糊效果自然均匀。可有效去除高斯噪声，也常作为 Canny 边缘检测的预处理步骤。Sigma 值设为 0 时，OpenCV 会根据核大小自动计算。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size (odd) | 核大小（奇数） | 1~31 | 5 |
| Sigma X | X 方向标准差 | 0~100 | 0 |
| Sigma Y | Y 方向标准差 | 0~100 | 0 |

#### Median Blur — 中值模糊

用邻域像素的中值替换当前像素。与高斯模糊的加权平均不同，中值滤波取的是"中间值"，因此对椒盐噪声（随机出现的黑白噪点）特别有效——因为噪点的极端值不会成为中值。同时，中值滤波能比均值滤波更好地保留边缘细节。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size (odd) | 核大小（奇数） | 1~31 | 5 |

#### Bilateral Filter — 双边滤波

在平滑的同时保留边缘，是"美颜"类处理的核心算法。与普通模糊不同，双边滤波同时考虑两个因素：空间距离（离中心越近权重越大）和像素值差异（颜色越接近权重越大）。这意味着在同一颜色区域内会进行平滑，但跨越边缘时权重骤降，从而保留边缘。Sigma Color 控制颜色差异的容忍度，Sigma Space 控制空间距离的影响范围。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Neighborhood Diameter | 邻域直径 | 1~50 | 9 |
| Sigma Color | 颜色空间标准差 | 1~500 | 75 |
| Sigma Space | 坐标空间标准差 | 1~500 | 75 |

### 🧱 Morphology — 形态学操作

形态学操作基于结构元素（Structuring Element）与图像的集合运算，主要用于二值图像或灰度图像的后处理。结构元素有三种形状：Rect（矩形）、Cross（十字）、Ellipse（椭圆），不同形状适用于不同的目标轮廓。

#### Erode — 腐蚀

使图像中的白色区域缩小、黑色区域扩大。原理：用结构元素扫描图像，只有当结构元素完全包含在前景中时，中心像素才保留为前景。常用于去除小噪点、分离粘连物体。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size | 结构元素大小 | 1~31 | 3 |
| Kernel Shape | 结构元素形状 | Rect / Cross / Ellipse | Rect |
| Iterations | 迭代次数 | 1~20 | 1 |

#### Dilate — 膨胀

与腐蚀相反，使图像中的白色区域扩大、黑色区域缩小。原理：只要结构元素与前景有任意重叠，中心像素就设为前景。常用于填充小孔洞、连接断裂区域。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size | 结构元素大小 | 1~31 | 3 |
| Kernel Shape | 结构元素形状 | Rect / Cross / Ellipse | Rect |
| Iterations | 迭代次数 | 1~20 | 1 |

#### Open / Close — 开运算 / 闭运算

开运算 = 先腐蚀后膨胀，可去除小的白色噪点而不明显改变主体轮廓；闭运算 = 先膨胀后腐蚀，可填充小的黑色孔洞而不明显改变主体轮廓。两者组合使用是形态学后处理的标准流程。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Operation | 操作类型 | Open / Close | Open |
| Kernel Size | 结构元素大小 | 1~31 | 3 |
| Kernel Shape | 结构元素形状 | Rect / Cross / Ellipse | Rect |
| Iterations | 迭代次数 | 1~20 | 1 |

#### Morphological Gradient — 形态学梯度

膨胀结果减去腐蚀结果，提取物体的边缘轮廓。效果类似于边缘检测，但基于形态学运算而非微分，对二值图像特别有效。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Kernel Size | 结构元素大小 | 1~31 | 3 |
| Kernel Shape | 结构元素形状 | Rect / Cross / Ellipse | Rect |
| Iterations | 迭代次数 | 1~20 | 1 |

### 👤 Face Detection — 人脸检测

#### Haar Face Detection — Haar 人脸检测

使用 Haar 级联分类器检测人脸，是 OpenCV 中最经典的人脸检测方法。Haar 特征通过黑白相邻矩形区域的像素差来描述局部纹理（如眼睛区域比脸颊暗），通过 AdaBoost 筛选最有效的特征组合，利用图像金字塔实现多尺度检测。在原图上绘制绿色矩形框标注人脸位置。速度快，适合实时场景。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Scale Factor | 图像缩放因子 | 1.01~3.0 | 1.1 |
| Min Neighbors | 最小邻居数 | 0~20 | 5 |
| Min Face Width | 最小人脸宽度 | 10~500 | 30 |
| Min Face Height | 最小人脸高度 | 10~500 | 30 |

#### DNN Face Detection — DNN 人脸检测

使用 Caffe SSD（Single Shot Detector）深度神经网络模型检测人脸。相比 Haar 的手工特征，DNN 通过大量数据训练学习人脸特征，精度更高、对角度和遮挡更鲁棒。在原图上绘制绿色矩形框并标注置信度百分比。需要提供 Caffe 模型文件（`.prototxt` + `.caffemodel`）。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Confidence Threshold | 置信度阈值 | 0.1~1.0 | 0.5 |

### 📱 QR Detection — 二维码检测

#### QR Code Detection — 二维码检测

检测图像中的二维码，绘制绿色边框标注位置，并可解码显示二维码内容文本。使用 OpenCV 内置的 `QRCodeDetector`，支持标准 QR Code 的检测与解码。解码结果存储在 `ImageData` 的元数据中，同时可选在图像上方显示解码文本。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Show Decoded Text | 是否显示解码文本 | true/false | true |

### 🔗 Feature Matching — 特征匹配

特征匹配处理器需要**两张图片**作为输入（主图 + 第二张图），在两张图片之间检测关键点并建立匹配关系，输出并排对比图，用绿线连接匹配点。这类处理器通过 `requiresSecondImage()` 接口声明其特殊需求，管线会自动注入第二张图片。

#### SIFT Feature Matching — SIFT 特征匹配

使用 SIFT（Scale-Invariant Feature Transform）算法检测和匹配特征点。SIFT 是尺度不变特征，对旋转、缩放、光照变化具有很好的鲁棒性，是计算机视觉中最经典的特征描述子。使用 BFMatcher + L2 距离进行匹配，并通过 Lowe's Ratio Test 过滤误匹配。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Number of Features | 特征点数量 | 100~5000 | 500 |
| Octave Layers | 金字塔层数 | 1~10 | 3 |
| Contrast Threshold | 对比度阈值 | 0.01~1.0 | 0.04 |
| Lowe's Ratio Threshold | Lowe 比值阈值 | 0.1~1.0 | 0.75 |
| Max Matches to Display | 最大显示匹配数 | 1~500 | 50 |

#### ORB Feature Matching — ORB 特征匹配

使用 ORB（Oriented FAST and Rotated BRIEF）算法检测和匹配特征点。ORB 是 SIFT/BRIEF 的开源替代方案，速度比 SIFT 快一个数量级且无专利限制。使用 BFMatcher + Hamming 距离（适用于二进制描述子）进行匹配，同样通过 Lowe's Ratio Test 过滤误匹配。

| 参数 | 说明 | 范围 | 默认值 |
|------|------|------|--------|
| Number of Features | 特征点数量 | 100~5000 | 500 |
| Scale Factor | 缩放因子 | 1.01~2.0 | 1.2 |
| Pyramid Levels | 金字塔层数 | 1~20 | 8 |
| Lowe's Ratio Threshold | Lowe 比值阈值 | 0.1~1.0 | 0.75 |
| Max Matches to Display | 最大显示匹配数 | 1~500 | 50 |

### 插件总览

| 分类 | 处理器数量 | 包含 | 典型应用场景 |
|------|-----------|------|------------|
| Color Conversion | 2 | Grayscale, HSV | 预处理、颜色分割 |
| Edge Detection | 3 | Canny, Sobel, Laplacian | 轮廓提取、特征检测 |
| Threshold | 3 | Binary, Adaptive, Otsu | 目标分割、文档二值化 |
| Filtering | 3 | Gaussian, Median, Bilateral | 降噪、平滑、美颜 |
| Morphology | 4 | Erode, Dilate, Open/Close, Gradient | 后处理、形态学增强 |
| Face Detection | 2 | Haar, DNN | 人脸检测与标注 |
| QR Detection | 1 | QR Code | 二维码识别与解码 |
| Feature Matching | 2 | SIFT, ORB | 图像配准、目标识别 |
| **合计** | **20** | | |

每个插件都是独立的共享库，可独立编译和分发。新增处理器只需实现 `IImageProcessor` 接口并注册为 Qt 插件，无需修改主程序任何代码。

## 项目结构

```
SmartVisionWorkbench/
├── CMakeLists.txt                     # 顶层构建，聚合所有子目录
├── src/
│   ├── main.cpp                       # 入口
│   ├── CMakeLists.txt                 # 主程序构建
│   ├── app/
│   │   ├── Application.h/cpp          # 应用类（主题加载等）
│   │   └── MainWindow.h/cpp           # 主窗口（组合根）
│   ├── core/
│   │   ├── IImageProcessor.h          # 处理器接口 + 参数描述
│   │   ├── IPluginFactory.h           # 插件工厂接口
│   │   ├── ImageData.h/cpp            # 图像数据封装
│   │   ├── PipelineNode.h             # 管线节点
│   │   ├── ProcessingPipeline.h/cpp   # 异步处理管线
│   │   ├── PluginManager.h/cpp        # 插件加载与管理
│   │   └── ProjectModel.h/cpp         # 项目序列化
│   ├── capture/
│   │   ├── CameraDevice.h/cpp         # 摄像头采集（独立线程）
│   │   ├── FrameGrabber.h/cpp         # 帧抓取与转换
│   │   └── ImageFileSource.h/cpp      # 文件图像源
│   ├── ui/
│   │   ├── ImageCanvas.h/cpp          # 自定义画布（缩放/平移/ROI）
│   │   ├── ComparisonView.h/cpp       # 三模式对比视图
│   │   ├── PipelinePanel.h/cpp        # 管线步骤管理面板
│   │   ├── ParameterPanel.h/cpp       # 动态参数面板
│   │   ├── SourcePanel.h/cpp          # 图像源选择面板
│   │   └── HistoryPanel.h/cpp         # 处理历史面板
│   └── utils/
│       ├── CvMatToQImage.h/cpp        # OpenCV ↔ Qt 图像转换
│       ├── ScopedCvTimer.h            # RAII 计时器
│       └── JsonHelper.h/cpp           # JSON 工具
├── plugins/
│   ├── edge_detection/                # 边缘检测插件
│   ├── filtering/                     # 滤波插件
│   ├── threshold/                     # 阈值插件
│   ├── morphology/                    # 形态学插件
│   ├── color_conversion/              # 颜色转换插件
│   ├── face_detection/                # 人脸检测插件
│   ├── feature_matching/              # 特征匹配插件
│   └── qr_detection/                  # 二维码检测插件
└── resources/
    └── resources.qrc                  # Qt 资源文件
```

## 架构亮点总结

| 亮点 | 实现方式 | 技术价值 |
|-----|---------|---------|
| **零 UI 插件开发** | `ParameterDescriptor` 元数据驱动 UI 生成 | 新增算法无需写界面代码，关注点分离 |
| **实时帧丢弃** | `QAtomicInt` 无锁判断 + `QtConcurrent` 异步 | 摄像头模式下 UI 始终流畅 |
| **双形态插件** | `IPluginFactory` + `IImageProcessor` 双接口 | 灵活支持单算法和多算法打包 |
| **三模式对比** | SideBySide / Overlay / Diff | 专业级处理效果评估体验 |
| **项目可复现** | JSON 序列化管线状态 | 处理流程可保存、分享、复现 |
| **跨平台插件** | 运行时判断 `.dll` / `.so` / `.dylib` | 同一架构适配 Windows/Linux/macOS |

---
