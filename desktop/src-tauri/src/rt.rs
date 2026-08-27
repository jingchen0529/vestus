//! 应用自有的 Tokio 运行时。
//!
//! 本地代理适配器需要在 Tauri 事件循环之外长期运行，所以这里持有一个独立运行时，
//! 不依赖 Tauri 内部的 async_runtime 实现细节。

use std::sync::OnceLock;

use tokio::runtime::{Builder, Runtime};

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("vestus-net")
            .enable_all()
            .build()
            .expect("构建 Tokio 运行时失败")
    })
}
