---
title: Qt Widgets 实战：布局、自定义控件与样式表
published: 2026-06-14
description: '从布局管理到自定义控件开发，分享 Qt Widgets 实际项目中的开发技巧与最佳实践'
image: ''
tags: [Qt, C++, Widgets, UI开发]
category: 技术笔记
draft: false
lang: zh
---

Qt Widgets 是 Qt 传统的桌面 UI 开发方案，虽然 QML 在移动端更流行，但在工业软件、工具类应用领域，Widgets 依然是主力。本文分享实际项目中的 Widgets 开发经验。

## 布局管理：让界面自适应

### 四大布局类

```cpp
QHBoxLayout  // 水平排列
QVBoxLayout  // 垂直排列
QGridLayout  // 网格排列
QFormLayout  // 表单排列（标签-输入对）
```

### 布局嵌套：构建复杂界面

实际项目的界面很少是单一布局，而是嵌套组合：

```cpp
auto *mainLayout = new QVBoxLayout(window);

// 顶部工具栏：水平布局
auto *toolbar = new QHBoxLayout;
toolbar->addWidget(new QPushButton("新建"));
toolbar->addWidget(new QPushButton("打开"));
toolbar->addStretch(); // 弹性空白，把按钮推向左侧
toolbar->addWidget(new QPushButton("设置"));
mainLayout->addLayout(toolbar);

// 中间内容区：水平分割
auto *contentLayout = new QHBoxLayout;

// 左侧导航树
auto *treeView = new QTreeView;
treeView->setMaximumWidth(250);
contentLayout->addWidget(treeView, 1); // stretch=1

// 右侧工作区
auto *stackWidget = new QStackedWidget;
contentLayout->addWidget(stackWidget, 3); // stretch=3，占比更大

mainLayout->addLayout(contentLayout, 1); // 内容区占据主要空间

// 底部状态栏
auto *statusBar = new QHBoxLayout;
statusBar->addWidget(new QLabel("就绪"));
mainLayout->addLayout(statusBar);
```

### 布局常见陷阱

```cpp
// ❌ 同时设置固定大小和布局拉伸，布局拉伸失效
widget->setFixedSize(200, 100);

// ✅ 用 sizePolicy 控制伸缩行为
widget->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Fixed);
widget->setMinimumHeight(40);

// ❌ 给布局内的控件设置多余的 margin
layout->setContentsMargins(0, 0, 0, 0); // 需要时才去除边距
```

### QSplitter：可拖拽分割

比布局更灵活的分割方式，用户可以拖拽调整大小：

```cpp
auto *splitter = new QSplitter(Qt::Horizontal);
splitter->addWidget(treeView);
splitter->addWidget(stackWidget);
splitter->setStretchFactor(0, 1); // 左侧比例
splitter->setStretchFactor(1, 3); // 右侧比例
splitter->setSizes({200, 600});   // 初始大小
```

## 自定义控件开发

### 方式一：组合现有控件

最常见的自定义控件方式——将多个基础控件组合封装：

```cpp
class SearchBox : public QWidget {
    Q_OBJECT
public:
    explicit SearchBox(QWidget *parent = nullptr) : QWidget(parent) {
        auto *layout = new QHBoxLayout(this);
        layout->setContentsMargins(0, 0, 0, 0);

        m_lineEdit = new QLineEdit;
        m_lineEdit->setPlaceholderText("搜索...");

        m_clearBtn = new QPushButton("✕");
        m_clearBtn->setFixedSize(24, 24);
        m_clearBtn->setFlat(true);

        layout->addWidget(m_lineEdit);
        layout->addWidget(m_clearBtn);

        connect(m_clearBtn, &QPushButton::clicked, m_lineEdit, &QLineEdit::clear);
        connect(m_lineEdit, &QLineEdit::textChanged, this, &SearchBox::textChanged);
    }

    QString text() const { return m_lineEdit->text(); }

signals:
    void textChanged(const QString &text);

private:
    QLineEdit *m_lineEdit;
    QPushButton *m_clearBtn;
};
```

### 方式二：重写 paintEvent 绘制

当需要完全自定义外观时，直接绘制：

```cpp
class CircularProgress : public QWidget {
    Q_OBJECT
    Q_PROPERTY(int value READ value WRITE setValue NOTIFY valueChanged)
public:
    explicit CircularProgress(QWidget *parent = nullptr)
        : QWidget(parent), m_value(0) {
        setFixedSize(120, 120);
    }

    void setValue(int v) {
        if (m_value != v) {
            m_value = v;
            update(); // 触发重绘
            emit valueChanged(v);
        }
    }

    int value() const { return m_value; }

signals:
    void valueChanged(int value);

protected:
    void paintEvent(QPaintEvent *) override {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);

        int side = qMin(width(), height());
        painter.translate(width() / 2.0, height() / 2.0);

        // 背景圆环
        QPen bgPen(QColor("#e0e0e0"), 8, Qt::SolidLine, Qt::RoundCap);
        painter.setPen(bgPen);
        painter.drawArc(-side / 2 + 10, -side / 2 + 10,
                        side - 20, side - 20, 0, 360 * 16);

        // 进度圆环
        QPen fgPen(QColor("#4CAF50"), 8, Qt::SolidLine, Qt::RoundCap);
        painter.setPen(fgPen);
        int span = static_cast<int>(m_value / 100.0 * 360 * 16);
        painter.drawArc(-side / 2 + 10, -side / 2 + 10,
                        side - 20, side - 20, 90 * 16, -span);

        // 中心文字
        painter.setPen(Qt::black);
        painter.setFont(QFont("Arial", 20, QFont::Bold));
        painter.drawText(QRect(-side / 2, -side / 2, side, side),
                        Qt::AlignCenter, QString::number(m_value) + "%");
    }

private:
    int m_value;
};
```

### 方式三：QStyle 完全定制

适用于需要统一风格的全局定制，工作量较大，适合大型项目。日常开发中 QSS + 组合控件通常就够用了。

## QSS 样式表：快速美化界面

### 基础用法

```css
/* 全局样式 */
QApplication::setStyleSheet(R"(
    /* 按钮样式 */
    QPushButton {
        background-color: #2196F3;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 24px;
        font-size: 14px;
    }
    QPushButton:hover {
        background-color: #1976D2;
    }
    QPushButton:pressed {
        background-color: #0D47A1;
    }
    QPushButton:disabled {
        background-color: #BDBDBD;
    }

    /* 输入框样式 */
    QLineEdit {
        border: 1px solid #BDBDBD;
        border-radius: 4px;
        padding: 6px 12px;
        background: white;
    }
    QLineEdit:focus {
        border-color: #2196F3;
    }
)");
```

### 按控件定制

```css
/* 通过 objectName 定制特定控件 */
QPushButton#startBtn {
    background-color: #4CAF50;
    font-size: 16px;
    font-weight: bold;
}

/* 通过属性选择器 */
QCheckBox[checked="true"] {
    color: #4CAF50;
}
```

```cpp
button->setObjectName("startBtn");  // QSS 中通过 #startBtn 定位
```

### QSS 的局限

QSS 不是万能的，以下场景需要用 `paintEvent` 或 `QStyle`：

- **渐变背景**：QSS 支持有限，复杂渐变需绘制
- **自定义形状控件**：QSS 只能做矩形圆角
- **动画效果**：QSS 不支持过渡动画
- **子控件精细控制**：如 `QComboBox` 的下拉箭头位置

## Model/View 架构

Qt Widgets 的数据展示遵循 Model/View/Delegate 模式：

```
Model（数据） ←→ View（展示） ←→ Delegate（编辑）
```

### 自定义 TableModel 示例

```cpp
class DeviceModel : public QAbstractTableModel {
    Q_OBJECT
public:
    int rowCount(const QModelIndex &) const override {
        return m_devices.size();
    }
    int columnCount(const QModelIndex &) const override { return 3; }

    QVariant data(const QModelIndex &index, int role) const override {
        if (role != Qt::DisplayRole) return {};
        const auto &dev = m_devices[index.row()];
        switch (index.column()) {
        case 0: return dev.name;
        case 1: return dev.address;
        case 2: return dev.status ? "在线" : "离线";
        }
        return {};
    }

    QVariant headerData(int section, Qt::Orientation, int role) const override {
        if (role != Qt::DisplayRole) return {};
        switch (section) {
        case 0: return "设备名";
        case 1: return "地址";
        case 2: return "状态";
        }
        return {};
    }

    void updateDevices(const QVector<Device> &devices) {
        beginResetModel();
        m_devices = devices;
        endResetModel();
    }

private:
    QVector<Device> m_devices;
};
```

**关键点**：调用 `beginResetModel()` / `endResetModel()` 通知 View 刷新，不要忘记。

## 实用技巧汇总

| 场景 | 技巧 |
|-----|------|
| 界面卡顿 | 耗时操作放子线程，信号通知 UI 更新 |
| 布局抖动 | 设置 `minimumSize` 而非 `fixedSize` |
| 样式不生效 | 检查选择器优先级和控件层级 |
| 表格性能 | 用 `QAbstractTableModel` + 批量更新 |
| 多窗口协调 | 通过信号槽通信，不要互相持有指针 |
| DPI 适配 | 使用 `qApp->devicePixelRatio()`，图标用 SVG |

> Qt Widgets 的学习曲线在"能跑起来"之后变平，真正的提升来自理解布局策略、掌握自定义控件开发、以及合理运用 Model/View 架构。这些能力在桌面工具和工业软件领域非常受重视。
